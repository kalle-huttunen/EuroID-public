/**
 * Command Palette (Cmd+K / Ctrl+K) — quick navigation + identity search.
 * Uses cmdk library for composable command menu.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Command } from 'cmdk';
import { theme, Tag } from 'antd';
import { SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useCommandPaletteStore } from '@stores/command-palette-store';
import { visibleNavItems } from '../layout/navigation';
import { usePermission } from '../../auth/usePermission';
import { usePlatformAdmin } from '../../auth/usePlatformAdmin';
import { OVERLAY } from '../../theme';
import { identityPath } from '../../features/users/identity-path';

interface SearchResult {
  _id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  displayName?: string;
  status?: string;
}

export const CommandPalette: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const open = useCommandPaletteStore((st) => st.open);
  const setOpen = useCommandPaletteStore((st) => st.setOpen);
  const toggle = useCommandPaletteStore((st) => st.toggle);
  const [search, setSearch] = useState('');
  const [identityResults, setIdentityResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped on every query change: only the latest search may set the results. */
  const searchSeq = useRef(0);
  const isSuperAdmin = usePermission('super-admin');
  const isOperator = usePermission('operator');
  const isPolicyAdmin = usePermission('policy-admin');
  const { isPlatformAdmin } = usePlatformAdmin();
  // Same gating as the sidebar: admin, platform and developer pages only for those who may see them.
  const pages = useMemo(
    () => visibleNavItems({ isSuperAdmin, isPlatformAdmin, isOperator, isPolicyAdmin }),
    [isSuperAdmin, isPlatformAdmin, isOperator, isPolicyAdmin],
  );

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        toggle();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle, setOpen]);

  // Search identities with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const seq = ++searchSeq.current;
    if (search.length < 2) {
      setIdentityResults([]);
      setSearching(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await axiosInstance.get(`${API_BASE}/identity`, {
          params: { _start: 0, _end: 8, q: search },
        });
        if (seq === searchSeq.current) setIdentityResults(Array.isArray(data) ? data : []);
      } catch {
        if (seq === searchSeq.current) setIdentityResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 250);
  }, [search]);

  const handleSelect = useCallback(
    (path: string) => {
      navigate(path);
      setOpen(false);
      setSearch('');
    },
    [navigate, setOpen],
  );

  if (!open) return null;

  const identityName = (r: SearchResult) =>
    r.displayName || [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || 'Unknown';

  return (
    <>
      {/* Backdrop */}
      <div
        className="cmdk-overlay"
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: OVERLAY.backdrop,
          backdropFilter: 'blur(2px)',
        }}
      />
      {/* Dialog */}
      <div
        className="cmdk-dialog"
        style={{
          position: 'fixed',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          width: '100%',
          maxWidth: 560,
          padding: '0 16px',
        }}
      >
        <Command
          label="Command palette"
          style={{
            background: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorder}`,
            boxShadow: token.boxShadowSecondary,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <SearchOutlined style={{ color: token.colorTextSecondary, fontSize: 16 }} />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search identities, pages, actions..."
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 15,
                color: token.colorText,
                fontFamily: token.fontFamily,
              }}
            />
            <Tag style={{ margin: 0, fontSize: 11 }}>Esc</Tag>
          </div>

          <Command.List
            style={{
              maxHeight: 360,
              overflow: 'auto',
              padding: '8px 0',
            }}
          >
            <Command.Empty
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: token.colorTextSecondary,
                fontSize: 13,
              }}
            >
              {searching ? 'Searching...' : 'No results found'}
            </Command.Empty>

            {/* Identity search results */}
            {identityResults.length > 0 && (
              <Command.Group heading="Identities" style={{ padding: '0 8px' }}>
                {identityResults.map((r) => (
                  <Command.Item
                    key={r._id}
                    value={`identity ${identityName(r)} ${r.email || ''}`}
                    onSelect={() => handleSelect(identityPath(r._id))}
                    style={{
                      padding: '8px 12px',
                      borderRadius: token.borderRadiusSM,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                    }}
                  >
                    <UserOutlined style={{ color: token.colorTextSecondary }} />
                    <span style={{ flex: 1 }}>
                      <span style={{ fontWeight: 500 }}>{identityName(r)}</span>
                      {r.email && (
                        <span style={{ color: token.colorTextSecondary, marginLeft: 8 }}>
                          {r.email}
                        </span>
                      )}
                    </span>
                    {r.status && (
                      <Tag
                        color={r.status === 'active' ? 'success' : 'default'}
                        style={{ fontSize: 11, margin: 0 }}
                      >
                        {r.status}
                      </Tag>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Page navigation */}
            <Command.Group heading="Pages" style={{ padding: '0 8px' }}>
              {pages.map((page) => (
                <Command.Item
                  key={page.path}
                  value={`${page.label} ${page.section ?? ''}`}
                  onSelect={() => handleSelect(page.path)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: token.borderRadiusSM,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 13,
                  }}
                >
                  {page.icon}
                  <span>{page.label}</span>
                  <span
                    style={{ marginLeft: 'auto', fontSize: 11, color: token.colorTextSecondary }}
                  >
                    {page.section ?? 'Overview'}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          <div
            style={{
              padding: '8px 16px',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              gap: 16,
              fontSize: 11,
              color: token.colorTextSecondary,
            }}
          >
            <span>
              <kbd
                style={{
                  padding: '1px 4px',
                  borderRadius: 3,
                  border: `1px solid ${token.colorBorder}`,
                  fontSize: 10,
                }}
              >
                &uarr;&darr;
              </kbd>{' '}
              navigate
            </span>
            <span>
              <kbd
                style={{
                  padding: '1px 4px',
                  borderRadius: 3,
                  border: `1px solid ${token.colorBorder}`,
                  fontSize: 10,
                }}
              >
                &crarr;
              </kbd>{' '}
              select
            </span>
            <span>
              <kbd
                style={{
                  padding: '1px 4px',
                  borderRadius: 3,
                  border: `1px solid ${token.colorBorder}`,
                  fontSize: 10,
                }}
              >
                esc
              </kbd>{' '}
              close
            </span>
          </div>
        </Command>
      </div>
    </>
  );
};
