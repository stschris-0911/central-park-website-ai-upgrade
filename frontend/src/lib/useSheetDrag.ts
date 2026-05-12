import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent
} from "react";

export type SheetLevel = "peek" | "half" | "full";

const SHEET_LEVELS: SheetLevel[] = ["peek", "half", "full"];
const DRAG_THRESHOLD = 42;
const DRAG_STEP = 110;

function clampIndex(index: number): number {
  return Math.max(0, Math.min(SHEET_LEVELS.length - 1, index));
}

function shiftLevel(level: SheetLevel, steps: number): SheetLevel {
  const index = SHEET_LEVELS.indexOf(level);
  return SHEET_LEVELS[clampIndex(index + steps)];
}

function nextLevel(level: SheetLevel): SheetLevel {
  if (level === "peek") return "half";
  if (level === "half") return "full";
  return "peek";
}

function levelLabel(level: SheetLevel): string {
  if (level === "peek") return "small";
  if (level === "half") return "half height";
  return "full height";
}

export function useSheetDrag(name: string, initialLevel: SheetLevel = "peek") {
  const [level, setLevel] = useState<SheetLevel>(initialLevel);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startLevelRef = useRef<SheetLevel>(initialLevel);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);

  const style = useMemo(
    () =>
      ({
        "--sheet-drag-y": `${dragY}px`
      }) as CSSProperties,
    [dragY]
  );

  function settle(deltaY: number) {
    setDragY(0);
    if (Math.abs(deltaY) < DRAG_THRESHOLD) return;

    const direction = deltaY < 0 ? 1 : -1;
    const steps = Math.max(1, Math.min(2, Math.round(Math.abs(deltaY) / DRAG_STEP)));
    setLevel(shiftLevel(startLevelRef.current, direction * steps));
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    startYRef.current = event.clientY;
    startLevelRef.current = level;
    draggingRef.current = true;
    setIsDragging(true);
    setDragY(0);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (!draggingRef.current) return;
    setDragY(event.clientY - startYRef.current);
  }

  function handlePointerEnd(event: PointerEvent<HTMLElement>) {
    if (!draggingRef.current) return;
    const deltaY = event.clientY - startYRef.current;
    suppressClickRef.current = Math.abs(deltaY) > 8;
    draggingRef.current = false;
    setIsDragging(false);
    settle(deltaY);
    requestAnimationFrame(() => {
      suppressClickRef.current = false;
    });
  }

  function handleClick(event: MouseEvent<HTMLElement>) {
    if (suppressClickRef.current) {
      event.preventDefault();
      suppressClickRef.current = false;
      return;
    }
    setLevel(nextLevel(level));
  }

  return {
    level,
    setLevel,
    isDragging,
    isPeek: level === "peek",
    isFull: level === "full",
    style,
    sheetProps: {
      "data-dragging": isDragging,
      "data-sheet-level": level,
      style
    },
    handleProps: {
      "aria-label": `${name} drawer. Drag up or down. Current: ${levelLabel(level)}. Double tap for ${levelLabel(
        nextLevel(level)
      )}.`,
      "aria-expanded": level !== "peek",
      title: `${name} drawer`,
      onClick: handleClick,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerEnd,
      onPointerCancel: handlePointerEnd
    }
  };
}
