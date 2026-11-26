/**
 * Time Travel Slider — filter an identity's activity timeline to a point in time.
 *
 * Scrubs through significant timeline events and reports the selected date to
 * the parent, which filters the activity list. It does not reconstruct historical
 * access state: there is no backend endpoint for that (GET /identity/:id/access-at),
 * so the UI does not promise it.
 */

import { useState, useMemo } from 'react';
import { Slider, Typography, Space, DatePicker, Card } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ITimelineEvent } from '../../../interfaces';

interface TimeTravelSliderProps {
  /** Timeline events from UserTimeline (passed from parent to avoid duplicate fetch) */
  events: ITimelineEvent[];
  /** When a historical date is selected, show events up to that date */
  onDateChange?: (date: dayjs.Dayjs | null) => void;
}

export function TimeTravelSlider({
  events,
  onDateChange,
}: TimeTravelSliderProps) {
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());

  const handleDateChange = (date: dayjs.Dayjs | null) => {
    if (date) {
      setSelectedDate(date);
      onDateChange?.(date);
    }
  };

  // Build slider marks from significant events (role changes, access grants/revokes)
  const { marks, sortedEvents } = useMemo(() => {
    const significantTypes = ['GROUP_ASSIGNED', 'GROUP_REMOVED', 'LICENSE_ASSIGNED', 'LICENSE_REMOVED', 'USER_PROVISIONED', 'USER_DEPROVISIONED', 'POLICY_EVALUATED', 'DRIFT_DETECTED', 'DRIFT_RESOLVED'];
    const significant = events
      .filter((e) => significantTypes.includes(e.type))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const marksObj: Record<number, string> = {};
    significant.forEach((evt, idx) => {
      marksObj[idx] = dayjs(evt.timestamp).format('MMM D');
    });
    return { marks: marksObj, sortedEvents: significant };
  }, [events]);

  const maxIdx = Object.keys(marks).length - 1;

  const handleSliderChange = (value: number) => {
    if (sortedEvents[value]) {
      const d = dayjs(sortedEvents[value].timestamp);
      setSelectedDate(d);
      onDateChange?.(d);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <HistoryOutlined />
          <Typography.Text>Activity up to a date</Typography.Text>
        </Space>
      }
      style={{ marginBottom: 16 }}
      aria-label="Filter the activity timeline up to a selected date"
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <DatePicker
          value={selectedDate}
          onChange={(date) => date && handleDateChange(date)}
          disabledDate={(current) => current && current > dayjs()}
          style={{ width: 200 }}
          aria-label="Show activity up to this date"
        />
        {maxIdx >= 0 ? (
          <Slider
            min={0}
            max={maxIdx}
            marks={marks}
            onChange={handleSliderChange}
            tooltip={{ formatter: (value) => (value !== undefined ? marks[value] || '' : '') }}
            aria-label="Step through significant events"
          />
        ) : (
          <Typography.Text type="secondary">
            No significant events yet. Add users and run provisioning to see the timeline.
          </Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Filters the activity below to events on or before the selected date.
        </Typography.Text>
      </Space>
    </Card>
  );
}
