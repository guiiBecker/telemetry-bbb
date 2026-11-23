import { useEffect, useMemo, useRef } from 'react';
import { throttle } from '/imports/utils/throttle';

// A throttle that survives re-renders. Calling throttle() in the render body creates a new one, with
// fresh timing state, on every render, so with leading: true every call runs at once and nothing is
// throttled. This keeps one throttle per component and always runs the latest callback, so a trailing
// call never uses the state of the render that scheduled it.
const useStableThrottle = (
  callback: () => void,
  delay: number,
  { leading = true, trailing = true }: { leading?: boolean; trailing?: boolean } = {},
) => {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const throttled = useMemo(
    () => throttle(() => callbackRef.current(), delay, { leading, trailing }),
    [delay, leading, trailing],
  );

  useEffect(() => () => throttled.cancel(), [throttled]);

  return throttled;
};

export default useStableThrottle;
