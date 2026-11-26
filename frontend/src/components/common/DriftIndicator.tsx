/**
 * DriftIndicator – shows sync status for a profile field.
 * Green checkmark when in sync, yellow warning when drifted (with tooltip).
 */

import { Tooltip, theme } from "antd";
import { CheckCircleOutlined, WarningOutlined } from "@ant-design/icons";

export interface DriftIndicatorProps {
  field: string;
  isSynced: boolean;
  expectedValue?: string;
  actualValue?: string;
  connector?: string;
  onFix?: () => void;
}

export function DriftIndicator({
  field: _field,
  isSynced,
  expectedValue,
  actualValue,
  connector,
  onFix,
}: DriftIndicatorProps) {
  const { token } = theme.useToken();

  if (isSynced) {
    return (
      <span role="status" aria-label="In sync">
        <Tooltip title="In sync across all systems">
          <CheckCircleOutlined style={{ color: token.colorSuccess, marginLeft: 8 }} aria-hidden />
        </Tooltip>
      </span>
    );
  }

  return (
    <span role="status" aria-label="Drift detected">
      <Tooltip
      title={
        <div>
          <p>
            Hub says: <strong>{expectedValue ?? "—"}</strong>
          </p>
          <p>
            {connector ?? "Target"} says: <strong>{actualValue ?? "—"}</strong>
          </p>
          {onFix && (
            <a onClick={(e) => { e.stopPropagation(); onFix(); }}>
              Click to Fix
            </a>
          )}
        </div>
      }
    >
      <WarningOutlined style={{ color: token.colorWarning, marginLeft: 8 }} aria-hidden />
    </Tooltip>
    </span>
  );
}
