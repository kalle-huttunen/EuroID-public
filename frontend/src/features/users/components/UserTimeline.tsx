/**
 * UserTimeline Component
 *
 * Chronological event log for a user's lifecycle (created, provisioned, drift, etc.).
 * Fetches from GET /identity/:id/events.
 * Includes Time Travel slider to view access state at any point in time.
 */

import React, { useMemo, useState } from 'react';
import { TimeTravelSlider } from './TimeTravelSlider';
import {
  Timeline,
  Select,
  DatePicker,
  Input,
  Space,
  Typography,
  Tag,
  Collapse,
  Skeleton,
  theme,
} from 'antd';
import { API_BASE } from '@api/constants';
import { axiosInstance } from '@api/data';
import {
  UserAddOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
  AuditOutlined,
  UserDeleteOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { ITimelineEvent, TimelineEventType, TimelineEventSeverity } from '../../../interfaces';

dayjs.extend(relativeTime);

const { Text } = Typography;
const { RangePicker } = DatePicker;

const EVENT_TYPE_OPTIONS: { value: TimelineEventType | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'USER_CREATED', label: 'User Created' },
  { value: 'USER_UPDATED', label: 'User Updated' },
  { value: 'USER_PROVISIONED', label: 'User Provisioned' },
  { value: 'USER_DEPROVISIONED', label: 'User Deprovisioned' },
  { value: 'POLICY_EVALUATED', label: 'Policy Evaluated' },
  { value: 'DRIFT_DETECTED', label: 'Drift Detected' },
  { value: 'DRIFT_RESOLVED', label: 'Drift Resolved' },
  { value: 'GROUP_ASSIGNED', label: 'Group Assigned' },
  { value: 'GROUP_REMOVED', label: 'Group Removed' },
  { value: 'LICENSE_ASSIGNED', label: 'License Assigned' },
  { value: 'WORKFLOW_STARTED', label: 'Workflow Started' },
  { value: 'WORKFLOW_COMPLETED', label: 'Workflow Completed' },
  { value: 'LEAVER_DETECTED', label: 'Leaver Detected' },
];

function getSeverityColor(severity: TimelineEventSeverity): string {
  switch (severity) {
    case 'success':
      return 'green';
    case 'warning':
      return 'orange';
    case 'error':
      return 'red';
    default:
      return 'blue';
  }
}

function getEventIcon(type: TimelineEventType) {
  switch (type) {
    case 'USER_CREATED':
      return <UserAddOutlined />;
    case 'USER_PROVISIONED':
    case 'USER_DEPROVISIONED':
      return <SyncOutlined />;
    case 'POLICY_EVALUATED':
      return <AuditOutlined />;
    case 'DRIFT_DETECTED':
    case 'DRIFT_RESOLVED':
      return <ExclamationCircleOutlined />;
    case 'GROUP_ASSIGNED':
    case 'GROUP_REMOVED':
      return <TeamOutlined />;
    case 'LICENSE_ASSIGNED':
    case 'LICENSE_REMOVED':
      return <SafetyCertificateOutlined />;
    case 'WORKFLOW_STARTED':
    case 'WORKFLOW_COMPLETED':
      return <PlayCircleOutlined />;
    case 'APPROVAL_REQUESTED':
    case 'APPROVAL_GRANTED':
      return <ThunderboltOutlined />;
    case 'LEAVER_DETECTED':
      return <UserDeleteOutlined />;
    default:
      return <InfoCircleOutlined />;
  }
}

export interface UserTimelineProps {
  userId: string;
}

const TIMELINE_API = `${API_BASE}/identity`;

export const UserTimeline: React.FC<UserTimelineProps> = ({ userId }) => {
  const { token } = theme.useToken();
  const [eventTypeFilter, setEventTypeFilter] = useState<TimelineEventType | 'ALL'>('ALL');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(true);
  const [apiEvents, setApiEvents] = useState<ITimelineEvent[]>([]);
  const [timeTravelDate, setTimeTravelDate] = useState<Dayjs | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params: Record<string, string> = {};
        if (eventTypeFilter !== 'ALL') params.type = eventTypeFilter;
        const { data: json } = await axiosInstance.get(`${TIMELINE_API}/${userId}/events`, {
          params,
        });
        if (!cancelled) setApiEvents(Array.isArray(json) ? json : []);
      } catch {
        if (!cancelled) setApiEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, eventTypeFilter]);

  const events = useMemo(() => {
    let list = [...apiEvents];
    list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    if (eventTypeFilter !== 'ALL') {
      list = list.filter((e) => e.type === eventTypeFilter);
    }
    if (dateRange?.[0] && dateRange?.[1]) {
      const start = dateRange[0].startOf('day').toISOString();
      const end = dateRange[1].endOf('day').toISOString();
      list = list.filter((e) => e.timestamp >= start && e.timestamp <= end);
    }
    if (timeTravelDate) {
      list = list.filter((e) => new Date(e.timestamp) <= timeTravelDate.endOf('day').toDate());
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.description && e.description.toLowerCase().includes(q)) ||
          e.actor.toLowerCase().includes(q) ||
          (e.targetSystem && e.targetSystem.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [apiEvents, eventTypeFilter, dateRange, searchText, timeTravelDate]);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 4 }} />
        <Skeleton active paragraph={{ rows: 3 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: '0 8px' }}>
      <TimeTravelSlider events={apiEvents} onDateChange={(d) => setTimeTravelDate(d)} />
      <Space direction="vertical" size="middle" style={{ width: '100%', marginBottom: 16 }}>
        <Space wrap size="middle">
          <Select
            value={eventTypeFilter}
            onChange={(v) => setEventTypeFilter(v)}
            style={{ minWidth: 180 }}
            options={EVENT_TYPE_OPTIONS}
          />
          <RangePicker
            value={dateRange ?? undefined}
            onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
            allowClear
          />
          <Input.Search
            placeholder="Search events..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{ width: 220 }}
          />
        </Space>
      </Space>

      {events.length === 0 ? (
        <Text type="secondary">No events recorded yet.</Text>
      ) : (
        <Timeline
          items={events.map((evt) => ({
            color: getSeverityColor(evt.severity),
            dot: getEventIcon(evt.type),
            children: (
              <div>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap size="small">
                    <Text strong>{evt.title}</Text>
                    <Tag color={getSeverityColor(evt.severity)}>{evt.type}</Tag>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(evt.timestamp).format('MMM D, YYYY h:mm A')}
                    <span style={{ marginLeft: 8 }}>({dayjs(evt.timestamp).fromNow()})</span>
                  </Text>
                  {evt.description && <Text style={{ fontSize: 13 }}>{evt.description}</Text>}
                  <Space size="small">
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Actor: {evt.actor}
                    </Text>
                    {evt.targetSystem && <Tag>{evt.targetSystem}</Tag>}
                  </Space>
                  {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                    <Collapse ghost size="small">
                      <Collapse.Panel header="Details" key="meta">
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            background: token.colorFillQuaternary,
                            padding: 8,
                            borderRadius: 4,
                            overflow: 'auto',
                          }}
                        >
                          {JSON.stringify(evt.metadata, null, 2)}
                        </pre>
                      </Collapse.Panel>
                    </Collapse>
                  )}
                </Space>
              </div>
            ),
          }))}
        />
      )}
    </div>
  );
};
