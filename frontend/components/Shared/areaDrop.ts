import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { closestCenter, CollisionDetection } from '@dnd-kit/core';
import { sortableCursorHandlers } from './sortableList';

// Lets a sortable task list hand a dragged row to an area row in the sidebar.
// The sidebar is a separate component tree, and dnd-kit cancels native drags
// on sortable rows, so the pointer is hit-tested against sidebar rows that
// carry `data-area-drop-uid` while the existing reorder drag runs.

const AREA_ROW_ATTRIBUTE = 'data-area-drop-uid';

let hoveredAreaUid: string | null = null;
const listeners = new Set<() => void>();

const setHoveredAreaUid = (uid: string | null) => {
    if (uid === hoveredAreaUid) return;
    hoveredAreaUid = uid;
    listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

// The uid of the area row under the pointer while a task row is dragged.
export const useHoveredDropAreaUid = () =>
    useSyncExternalStore(
        subscribe,
        () => hoveredAreaUid,
        () => null
    );

// The sidebar's area rows carry `data-area-drop-uid={area.uid}`.
const areaUidAt = (x: number, y: number): string | null => {
    for (const element of document.elementsFromPoint(x, y)) {
        const row = element.closest(`[${AREA_ROW_ATTRIBUTE}]`);
        if (row) return row.getAttribute(AREA_ROW_ATTRIBUTE);
    }
    return null;
};

// While the pointer is over an area row nothing in the list is "over", so
// the rows stay put and a release is not a reorder.
const collisionDetectionWithAreas: CollisionDetection = (args) => {
    const { pointerCoordinates } = args;
    if (
        pointerCoordinates &&
        areaUidAt(pointerCoordinates.x, pointerCoordinates.y)
    ) {
        return [];
    }
    return closestCenter(args);
};

// Without `onAreaDrop` the list keeps its plain reorder drag. With it, a drag
// that is released over a sidebar area row calls it instead: `finish` returns
// true when it did, and the caller then skips its reorder.
export const useAreaDrop = (
    onAreaDrop?: (taskUid: string, areaUid: string) => void
) => {
    const stopTracking = useRef<() => void>(() => undefined);
    const lastPointer = useRef<{ x: number; y: number } | null>(null);

    const stop = useCallback(() => {
        stopTracking.current();
        stopTracking.current = () => undefined;
        lastPointer.current = null;
        setHoveredAreaUid(null);
    }, []);

    useEffect(() => stop, [stop]);

    if (!onAreaDrop) {
        return {
            collisionDetection: closestCenter,
            handlers: sortableCursorHandlers,
            finish: () => false,
        };
    }

    return {
        collisionDetection: collisionDetectionWithAreas,
        handlers: {
            onDragStart: () => {
                sortableCursorHandlers.onDragStart();
                const onMove = (e: MouseEvent) => {
                    lastPointer.current = { x: e.clientX, y: e.clientY };
                    setHoveredAreaUid(areaUidAt(e.clientX, e.clientY));
                };
                // Scrolling the sidebar moves rows under a still pointer
                // without a mousemove; element scrolls reach window only in
                // the capture phase.
                const onScroll = () => {
                    const pointer = lastPointer.current;
                    if (pointer) {
                        setHoveredAreaUid(areaUidAt(pointer.x, pointer.y));
                    }
                };
                window.addEventListener('mousemove', onMove, true);
                window.addEventListener('scroll', onScroll, true);
                stopTracking.current = () => {
                    window.removeEventListener('mousemove', onMove, true);
                    window.removeEventListener('scroll', onScroll, true);
                };
            },
            onDragCancel: () => {
                sortableCursorHandlers.onDragCancel();
                stop();
            },
        },
        finish: (taskUid: string) => {
            const pointer = lastPointer.current;
            const areaUid = pointer
                ? areaUidAt(pointer.x, pointer.y)
                : hoveredAreaUid;
            stop();
            if (!areaUid) return false;
            onAreaDrop(taskUid, areaUid);
            return true;
        },
    };
};
