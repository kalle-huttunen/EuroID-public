/**
 * Mobile header bar — visible only on screens < 768px
 * Hamburger (left) | EuroID (center) | User avatar (right)
 */

import React from "react";
import { Button, theme, Typography } from "antd";
import { MenuOutlined, UserOutlined } from "@ant-design/icons";
import { useMobileMenu } from "./MobileMenuContext";
import { NotificationCenter } from "./NotificationCenter";
import { Grid } from "antd";

const { useBreakpoint } = Grid;
const { Title } = Typography;

export const MobileHeader: React.FC = () => {
  const { token } = theme.useToken();
  const { open, setOpen } = useMobileMenu();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  if (!isMobile) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        height: 56,
        backgroundColor: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}
    >
      <Button
        type="text"
        icon={<MenuOutlined />}
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
      />
      <Title level={5} style={{ margin: 0, flex: 1, textAlign: "center" }}>
        EuroID
      </Title>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NotificationCenter />
        <UserOutlined style={{ color: token.colorTextSecondary, fontSize: 20 }} />
      </div>
    </div>
  );
};
