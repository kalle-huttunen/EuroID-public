/**
 * NodePalette — the Design studio's policy node rail, top-left on the canvas and collapsible.
 * Drag an item onto the canvas to add a condition or action node where it is dropped, or click
 * it (Enter or Space from the keyboard) to add it at the center of the visible canvas.
 * Connector actions come from the connector registry (each target connector's `policyActions`),
 * so the rail offers no action for a system the backend has no connector for.
 */
import React, { useId, useState } from 'react';
import { Button, Typography, theme } from 'antd';
import {
  FilterOutlined,
  TeamOutlined,
  UserOutlined,
  EnvironmentOutlined,
  IdcardOutlined,
  DeleteOutlined,
  BellOutlined,
  ThunderboltOutlined,
  UpOutlined,
  DownOutlined,
} from '@ant-design/icons';
import type { PolicyNodeTemplate } from './types/blueprint-canvas.types';
import { ALL_SYSTEMS_TARGET, TARGET_CONNECTORS } from './shared';

const { Text } = Typography;

interface PaletteItem extends PolicyNodeTemplate {
  key: string;
  label: string;
  icon: React.ReactNode;
}

const CONDITION_ITEMS: PaletteItem[] = [
  {
    key: 'dept',
    label: 'Department equals...',
    type: 'condition',
    data: { field: 'department', operator: 'equals', value: '' },
    icon: <TeamOutlined />,
  },
  {
    key: 'jobTitle',
    label: 'Job Title equals...',
    type: 'condition',
    data: { field: 'jobTitle', operator: 'equals', value: '' },
    icon: <IdcardOutlined />,
  },
  {
    key: 'location',
    label: 'Location equals...',
    type: 'condition',
    data: { field: 'location', operator: 'equals', value: '' },
    icon: <EnvironmentOutlined />,
  },
  {
    key: 'employmentType',
    label: 'Employment Type equals...',
    type: 'condition',
    data: { field: 'employmentType', operator: 'equals', value: '' },
    icon: <UserOutlined />,
  },
  {
    key: 'custom',
    label: 'Custom field equals...',
    type: 'condition',
    data: { field: '', operator: 'equals', value: '' },
    icon: <FilterOutlined />,
  },
];

/** Actions of the registered target connectors, then the actions on all systems. */
const ACTION_ITEMS: PaletteItem[] = [
  ...TARGET_CONNECTORS.flatMap((connector) =>
    (connector.policyActions ?? []).map(
      (action): PaletteItem => ({
        key: `${connector.id}-${action.actionType}`,
        label: action.label,
        type: 'action',
        data: { targetSystem: connector.id ?? connector.name, actionType: action.actionType },
        icon: connector.icon,
      }),
    ),
  ),
  {
    key: 'remove',
    label: 'Remove Access',
    type: 'action',
    data: { targetSystem: ALL_SYSTEMS_TARGET, actionType: 'remove_access' },
    icon: <DeleteOutlined />,
  },
  {
    key: 'notify',
    label: 'Send Notification',
    type: 'action',
    data: { targetSystem: ALL_SYSTEMS_TARGET, actionType: 'send_notification' },
    icon: <BellOutlined />,
  },
];

/** The drag payload useCanvasNodeManagement.onDrop reads. */
const DRAG_TYPE = 'application/reactflow';

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

interface PaletteEntryProps {
  item: PaletteItem;
  accent: string;
  onAdd: (item: PaletteItem) => void;
}

const PaletteEntry: React.FC<PaletteEntryProps> = ({ item, accent, onAdd }) => {
  const { token } = theme.useToken();
  return (
    <div role="listitem">
      <div
        role="button"
        tabIndex={0}
        draggable
        className="euroid-palette-item"
        aria-label={`Add ${item.type}: ${item.label}`}
        title="Drag onto the canvas, or click to add at the center"
        onDragStart={(event) => {
          event.dataTransfer.setData(
            DRAG_TYPE,
            JSON.stringify({ type: item.type, data: item.data }),
          );
          event.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => onAdd(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onAdd(item);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '4px 0',
          padding: '6px 10px',
          background: token.colorFillQuaternary,
          borderRadius: token.borderRadius,
          color: token.colorText,
          fontSize: 12,
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <span aria-hidden style={{ display: 'inline-flex', color: accent }}>
          {item.icon}
        </span>
        {item.label}
      </div>
    </div>
  );
};

export interface NodePaletteProps {
  /** Click, Enter or Space on an item: add that node at the center of the visible canvas. */
  onAdd: (template: PolicyNodeTemplate) => void;
}

export const NodePalette: React.FC<NodePaletteProps> = ({ onAdd }) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const bodyId = useId();

  const add = (item: PaletteItem) => {
    onAdd({ type: item.type, data: item.data });
    setAnnouncement(`Added ${item.type} "${item.label}" at the center of the canvas`);
  };

  const section = (title: string, icon: React.ReactNode, accent: string, items: PaletteItem[]) => (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden style={{ display: 'inline-flex', color: accent, fontSize: 12 }}>
          {icon}
        </span>
        <Text strong style={{ fontSize: 12 }}>
          {title}
        </Text>
      </div>
      <div role="list" aria-label={title}>
        {items.map((item) => (
          <PaletteEntry key={item.key} item={item} accent={accent} onAdd={add} />
        ))}
      </div>
    </div>
  );

  return (
    <div
      role="region"
      aria-label="Policy nodes"
      // nokey: React Flow ignores key presses here, so Delete in the rail never removes a node.
      className="nokey"
      style={{
        width: open ? 232 : undefined,
        padding: '8px 12px',
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowTertiary,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <Text strong style={{ fontSize: 13 }}>
          Policy nodes
        </Text>
        <Button
          type="text"
          size="small"
          icon={open ? <UpOutlined /> : <DownOutlined />}
          aria-label={open ? 'Hide policy nodes' : 'Show policy nodes'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        />
      </div>
      <div
        id={bodyId}
        hidden={!open}
        style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto', paddingBottom: 4 }}
      >
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          Drag onto the canvas, or click to add at the center.
        </Text>
        {section('Conditions', <FilterOutlined />, token.colorSuccess, CONDITION_ITEMS)}
        {section('Actions', <ThunderboltOutlined />, token.colorPrimary, ACTION_ITEMS)}
      </div>
      <div aria-live="polite" style={VISUALLY_HIDDEN}>
        {announcement}
      </div>
    </div>
  );
};
