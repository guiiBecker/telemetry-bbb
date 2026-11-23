import Auth from '/imports/ui/services/auth';

// Sends client log records to an endpoint in batches, every throttleInterval ms.
//
// It replaces @browser-bunyan/server-stream, which clears its buffer only when a request ends. So it
// re-sent the batch that was still in flight when the page closed (about 1.4% of the records reached
// the server twice) and dropped every record written while a request was in flight. Here a batch
// leaves the buffer when it is sent, so each record is sent once.
//
// Same wire format as the library: a JSON array of records, where records with the same msg are
// merged into one with a count.

type LogRecord = Record<string, unknown> & { msg?: string; count?: number };

const userAgent = typeof window !== 'undefined' ? window.navigator.userAgent : 'no-window';
const isBot = /bot|crawler|spider|crawling/i.test(userAgent);

export default class ServerLoggerStream {
  private logTagString: string | null = null;

  private records: Record<string, LogRecord> = {};

  private readonly url: string;

  private readonly method: string;

  private readonly throttleInterval: number;

  constructor(params: {
    enabled: boolean;
    url?: string;
    method?: string;
    throttleInterval?: number;
    flushOnClose?: boolean;
    logTag?: string;
  }) {
    this.url = params.url ?? '/log';
    this.method = params.method ?? 'PUT';
    this.throttleInterval = params.throttleInterval ?? 3000;
    if (params.logTag) {
      this.logTagString = params.logTag;
    }

    this.scheduleSend();
    if (params.flushOnClose && typeof window.fetch !== 'undefined') {
      // pagehide fires once the page is really going away (after beforeunload, which can be
      // cancelled) and also when it enters the back/forward cache; hidden covers mobile browsers
      // that kill a background tab without pagehide. Only records not sent yet go out.
      window.addEventListener('pagehide', () => this.sendOnClose());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.sendOnClose();
      });
    }
  }

  static getUserData() {
    const userInfo: Record<string, unknown> = {
      meetingId: Auth.meetingID,
      requesterUserId: Auth.userID,
      fullname: Auth.fullname,
      confname: Auth.confname,
      externUserID: Auth.externUserID,
      logoutUrl: Auth.logoutURL,
      sessionToken: Auth.sessionToken,
      clientSessionUUID: sessionStorage.getItem('clientSessionUUID') || '0',
    };

    return {
      fullInfo: userInfo,
    };
  }

  write(rec: LogRecord) {
    if (!window.navigator.onLine || isBot) return;

    const { fullInfo } = ServerLoggerStream.getUserData();
    const record = rec;
    if (fullInfo.meetingId != null) {
      record.userInfo = fullInfo;
    }
    record.clientBuild = window.meetingClientSettings?.public?.app?.html5ClientBuild;
    if (this.logTagString) {
      record.logTag = this.logTagString;
    }
    record.url = window.location.href;
    record.userAgent = userAgent;

    const key = String(record.msg);
    const existing = this.records[key];
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
    } else {
      record.count = 1;
      this.records[key] = record;
    }
  }

  // Takes the pending records out of the buffer: once taken, they are never sent again
  private takeBatch(): LogRecord[] {
    const batch = Object.values(this.records);
    this.records = {};
    return batch;
  }

  private scheduleSend() {
    window.setTimeout(() => this.sendBatch(), this.throttleInterval);
  }

  private sendBatch() {
    const batch = this.takeBatch();
    if (!batch.length) {
      this.scheduleSend();
      return;
    }
    const request = new XMLHttpRequest();
    request.onreadystatechange = () => {
      if (request.readyState !== XMLHttpRequest.DONE) return;
      if (request.status >= 400) {
        // eslint-disable-next-line no-console
        console.warn('ServerLoggerStream: a server log write failed');
      }
      this.scheduleSend();
    };
    request.open(this.method, this.url);
    request.setRequestHeader('Content-Type', 'application/json');
    request.send(JSON.stringify(batch));
  }

  private sendOnClose() {
    const batch = this.takeBatch();
    if (!batch.length) return;
    window.fetch(this.url, {
      method: this.method,
      body: JSON.stringify(batch),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {
      // The page is going away; there is nobody left to report to
    });
  }
}
