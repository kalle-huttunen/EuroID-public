/**
 * Map backend icon names to Ant Design icon components.
 */
import React from 'react';
import {
  WindowsOutlined,
  ClusterOutlined,
  BugOutlined,
  CloudOutlined,
  ApiOutlined,
  FileTextOutlined,
  MessageOutlined,
  GithubOutlined,
  TableOutlined,
  ApartmentOutlined,
  ToolOutlined,
} from '@ant-design/icons';

const ICON_MAP: Record<string, React.ReactNode> = {
  ApartmentOutlined: <ApartmentOutlined />,
  WindowsOutlined: <WindowsOutlined />,
  ClusterOutlined: <ClusterOutlined />,
  BugOutlined: <BugOutlined />,
  CloudOutlined: <CloudOutlined />,
  ApiOutlined: <ApiOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  MessageOutlined: <MessageOutlined />,
  GithubOutlined: <GithubOutlined />,
  TableOutlined: <TableOutlined />,
  ToolOutlined: <ToolOutlined />,
};

export function getConnectorIcon(iconName?: string): React.ReactNode {
  if (!iconName) return <CloudOutlined />;
  return ICON_MAP[iconName] ?? <CloudOutlined />;
}
