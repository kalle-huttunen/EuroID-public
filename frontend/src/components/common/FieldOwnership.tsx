/**
 * FieldOwnership – badge showing who owns/manages a field (HR, Connector, Manual).
 */

import { Tag, Tooltip } from "antd";
import { LockOutlined, CloudOutlined, EditOutlined } from "@ant-design/icons";
import React from "react";

export type OwnershipType = "hr" | "connector" | "manual";

export interface FieldOwnershipProps {
  owner: OwnershipType;
  source?: string; // e.g., "Workday", "Entra ID"
}

const OWNERSHIP_CONFIG: Record<
  OwnershipType,
  { color: string; icon: React.ReactNode; label: string; tooltip: string }
> = {
  hr: {
    color: "processing",
    icon: <LockOutlined />,
    label: "HR Managed",
    tooltip: "This field is managed by the HR system and cannot be edited here.",
  },
  connector: {
    color: "success",
    icon: <CloudOutlined />,
    label: "Synced",
    tooltip: "This field is synced from a connected system.",
  },
  manual: {
    color: "default",
    icon: <EditOutlined />,
    label: "Manual",
    tooltip: "This field can be edited manually.",
  },
};

export function FieldOwnership({ owner, source }: FieldOwnershipProps) {
  const config = OWNERSHIP_CONFIG[owner];
  const ariaLabel = source ? `Field managed by ${source}` : config.tooltip;
  return (
    <Tooltip
      title={`${config.tooltip}${source ? ` Source: ${source}` : ""}`}
    >
      <Tag color={config.color} icon={config.icon} style={{ marginLeft: 8 }} aria-label={ariaLabel}>
        {source || config.label}
      </Tag>
    </Tooltip>
  );
}
