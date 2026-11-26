/**
 * Canvas node labels on the wire.
 *
 * On the canvas a connector node's label is a React element (icon + name). JSON cannot carry an
 * element: it used to be posted as is and stored as `{ props: { children: [...] } }`, with the
 * icon reduced to `{ type: {} }`. serializeLabel turns the element into `{ text, icon }` (icon
 * key from ICON_MAP) for the save; reconstructNodeLabel rebuilds the element on load, and for a
 * label stored in the old shape takes the text from it and the icon from the node's connector.
 */
import React from 'react';
import { Space } from 'antd';
import {
  ApartmentOutlined,
  ApiOutlined,
  CloudOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  GithubOutlined,
  MessageOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { Node } from '@xyflow/react';
import { getConnectorById, getConnectorByName, parseConnectorNameFromNodeId } from '../shared';
import type { SerializedLabelData } from '../types/blueprint-canvas.types';

/** Every icon a canvas label uses (canvas/nodes.tsx, shared/connector-registry.ts). */
const ICON_MAP: Record<string, React.ComponentType> = {
  ApartmentOutlined,
  ApiOutlined,
  CloudOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  GithubOutlined,
  MessageOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
  ToolOutlined,
};

const BRAIN_ICON = 'RobotOutlined';

const tidy = (parts: string[]) => parts.join('').replace(/\s+/g, ' ').trim();

function iconKeyOf(node: React.ReactNode): string | undefined {
  if (!React.isValidElement(node)) return undefined;
  return Object.keys(ICON_MAP).find((key) => ICON_MAP[key] === node.type);
}

/** Text and first known icon of a rendered label. */
function readElement(node: React.ReactNode, acc: { text: string[]; icon?: string }): void {
  if (typeof node === 'string' || typeof node === 'number') {
    acc.text.push(String(node));
  } else if (Array.isArray(node)) {
    node.forEach((child) => readElement(child, acc));
  } else if (React.isValidElement(node)) {
    const icon = iconKeyOf(node);
    if (icon) acc.icon ??= icon;
    else readElement((node.props as { children?: React.ReactNode }).children, acc);
  }
}

/** The label as the canvas save sends it: text as is, an element as `{ text, icon }`. */
export function serializeLabel(label: unknown): unknown {
  if (!React.isValidElement(label)) return label;
  const acc: { text: string[]; icon?: string } = { text: [] };
  readElement(label, acc);
  const text = tidy(acc.text);
  return acc.icon ? { text, icon: acc.icon } : text;
}

/** Text of a label stored in the old shape: an element serialised by JSON.stringify. */
function legacyText(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(legacyText);
  if (value && typeof value === 'object') {
    return legacyText((value as { props?: { children?: unknown } }).props?.children);
  }
  return [];
}

/** The icon of the connector a node stands for, as canvas/nodes.tsx and useConnectorActions draw it. */
function connectorIconKey(node: Pick<Node, 'id' | 'data'>, text: string): string | undefined {
  if (node.data?.role === 'brain') return BRAIN_ICON;
  const type = typeof node.data?.type === 'string' ? node.data.type : '';
  const meta =
    getConnectorById(type) ??
    getConnectorByName(text) ??
    getConnectorByName(parseConnectorNameFromNodeId(node.id));
  return meta ? iconKeyOf(meta.icon) : undefined;
}

function withIcon(text: string, icon: string | undefined): React.ReactNode {
  const Icon = icon ? ICON_MAP[icon] : undefined;
  if (!Icon) return text;
  return (
    <Space>
      <Icon /> {text}
    </Space>
  );
}

/** The label element of a node loaded from GET /blueprints/latest. */
export function reconstructNodeLabel(node: Pick<Node, 'id' | 'data'>): React.ReactNode {
  const label = node.data?.label as string | SerializedLabelData | null | undefined;
  if (label === null || label === undefined || typeof label === 'string') return label;
  if (typeof label.text === 'string') return withIcon(label.text, label.icon);
  if (label.props) {
    const text = tidy(legacyText(label));
    return withIcon(text, connectorIconKey(node, text));
  }
  return null;
}
