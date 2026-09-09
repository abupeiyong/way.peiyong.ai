import { useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/types.ts";
import { fmtMin } from "../api.ts";

const DAY_START = 6 * 60;   // 06:00
const DAY_END = 24 * 60;    // 24:00
const PX_PER_HOUR = 44;
const SNAP = 15;

function minToY(min: number): number {
  return ((min - DAY_START) / 60) * PX_PER_HOUR;
}
function yToMin(y: number): number {
  const raw = DAY_START + (y / PX_PER_HOUR) * 60;
  return Math.round(raw / SNAP) * SNAP;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Props {
  tasks: Task[];
  isToday: boolean;
  onCreate: (startMin: number, endMin: number) => void;
  onMove: (task: Task, startMin: number, endMin: number) => void;
  onOpen: (task: Task) => void;
}

export default function ScheduleGrid({ tasks, isToday, onCreate, onMove, onOpen }: Props) {
  const blocks = tasks.filter((t) => t.start_min !== null && t.end_min !== null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  // during drag: {id, start, end} preview
  const [drag, setDrag] = useState<{ id: number; start: number; end: number } | null>(null);
  const dragRef = useRef<{ task: Task; mode: "move" | "resize"; grabOffset: number; moved: boolean } | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date();
      setNowMin(d.getHours() * 60 + d.getMinutes());
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const pointerY = (e: React.PointerEvent | PointerEvent): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    return e.clientY - rect.top;
  };

  const startDrag = (e: React.PointerEvent, task: Task, mode: "move" | "resize") => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      task,
      mode,
      grabOffset: yToMin(pointerY(e)) - (mode === "move" ? task.start_min! : task.end_min!),
      moved: false,
    };
    setDrag({ id: task.id, start: task.start_min!, end: task.end_min! });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const min = yToMin(pointerY(e)) - d.grabOffset;
    const dur = d.task.end_min! - d.task.start_min!;
    d.moved = true;
    if (d.mode === "move") {
      const start = clamp(min, DAY_START, DAY_END - dur);
      setDrag({ id: d.task.id, start, end: start + dur });
    } else {
      const end = clamp(min, d.task.start_min! + SNAP, DAY_END);
      setDrag({ id: d.task.id, start: d.task.start_min!, end });
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved && drag) onMove(d.task, drag.start, drag.end);
    else if (!d.moved) onOpen(d.task);
    setDrag(null);
  };

  const onDouble = (e: React.MouseEvent) => {
    if (!gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const start = clamp(yToMin(e.clientY - rect.top), DAY_START, DAY_END - 30);
    onCreate(start, Math.min(start + 60, DAY_END));
  };

  const hours = [];
  for (let h = DAY_START / 60; h < DAY_END / 60; h++) hours.push(h);

  return (
    <div className="schedule" onDoubleClick={onDouble}>
      {hours.map((h) => (
        <div className="schedule-hour" key={h}>
          <div className="h-label">{String(h).padStart(2, "0")}:00</div>
          <div className="h-slot" />
        </div>
      ))}
      <div className="schedule-blocks" ref={gridRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {isToday && nowMin >= DAY_START && nowMin <= DAY_END && (
          <div className="now-line" style={{ top: minToY(nowMin), left: 0 }} />
        )}
        {blocks.map((t) => {
          const view = drag?.id === t.id ? drag : { start: t.start_min!, end: t.end_min! };
          return (
            <div
              key={t.id}
              className={`schedule-block${t.done ? " done" : ""}`}
              style={{ top: minToY(view.start), height: Math.max(20, minToY(view.end) - minToY(view.start)) }}
              onPointerDown={(e) => startDrag(e, t, "move")}
            >
              <div>{t.title}</div>
              <div className="time">{fmtMin(view.start)}–{fmtMin(view.end)}</div>
              <div className="resize-handle" onPointerDown={(e) => startDrag(e, t, "resize")} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
