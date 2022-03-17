export {}
declare global {
    interface Event {
        bubbles: boolean;
        cancelBubble: () => void;
        cancelable: boolean;
        composed: boolean;
        composedPath: () => EventTarget[];
        currentTarget: EventTarget;
        defaultPrevented: boolean;
        eventPhase: number;
        isTrusted: boolean;
        preventDefault: () => void;
        returnValue: boolean;
        srcElement: EventTarget;
        target: EventTarget;
        stopImmediatePropagation: () => void;
        stopPropagation: () => void;
        timeStamp: number;
        type: string;
    }

    interface EventTarget {
        addEventListener(type: string, listener: Function, options?: {
            once?: boolean;
            passive?: boolean;
            capture?: boolean;
        });
        removeEventListener(type: string, listener: Function, options?: {
            capture?: boolean;
        });

        dispatchEvent(event: Event): boolean;
    }

    interface AbortController {
        /**
         * Returns the AbortSignal object associated with this object.
         */

        readonly signal: AbortSignal;

        /**
         * Invoking this method will set this object's AbortSignal's aborted flag and signal to any observers that the associated activity is to be aborted.
         */
        abort(): void;
    }

    /** A signal object that allows you to communicate with a DOM request (such as a Fetch) and abort it if required via an AbortController object. */
    interface AbortSignal extends EventTarget {
        /**
         * Returns true if this AbortSignal's AbortController has signaled to abort, and false otherwise.
         */
        readonly aborted: boolean;
    }
}
