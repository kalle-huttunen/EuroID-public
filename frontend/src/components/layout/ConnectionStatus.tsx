/**
 * WebSocket connection status indicator — small badge in sidebar.
 */
import React from "react";
import { Badge, Tooltip, Typography } from "antd";
import { useSocket } from "@api/realtime";

const { Text } = Typography;

export const ConnectionStatus: React.FC = () => {
  const { status } = useSocket();

  const config = {
    connected: { status: "success" as const, text: "Live", tooltip: "Real-time updates active" },
    connecting: { status: "processing" as const, text: "Connecting...", tooltip: "Connecting to real-time updates" },
    disconnected: { status: "error" as const, text: "Offline", tooltip: "Real-time updates unavailable" },
  };

  const { status: badgeStatus, text, tooltip } = config[status];

  return (
    <div aria-live="polite" aria-label={status === "connected" ? "Real-time connection active" : text}>
      <Tooltip title={tooltip}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0" }}>
          <Badge status={badgeStatus} />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {text}
          </Text>
        </div>
      </Tooltip>
    </div>
  );
};
