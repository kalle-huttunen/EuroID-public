import { Tag } from "antd";
import { useSocket } from "@api/realtime";

/** Compact "Live" tag — renders only when WebSocket is connected */
export function LiveBadge() {
  const { status } = useSocket();
  if (status !== "connected") return null;
  return (
    <span aria-live="polite" aria-label="Real-time connection active">
      <Tag color="success">Live</Tag>
    </span>
  );
}
