/**
 * CSV file upload with parsing. Emits parsed headers and rows for FieldMapper.
 */
import React from 'react';
import { Upload, Table, Alert, theme } from 'antd';
import type { UploadProps } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { parseCsv, detectHeaders, decodeCsvBytes } from './csv-utils';

const { Dragger } = Upload;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  raw: string;
}

interface CsvUploaderProps {
  value: ParsedCsv | null;
  onChange: (data: ParsedCsv | null) => void;
}

const csvAccept = '.csv';

export const CsvUploader: React.FC<CsvUploaderProps> = ({ value, onChange }) => {
  const { token } = theme.useToken();
  const handleFile = (file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!file.name.toLowerCase().endsWith('.csv')) {
        reject(new Error('Only CSV files are allowed'));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const bytes = e.target?.result;
          const text = bytes instanceof ArrayBuffer ? decodeCsvBytes(bytes) : '';
          const rows = parseCsv(text);
          const headers = rows.length > 0 ? detectHeaders(rows) : [];
          const dataRows = rows.length > 0 ? rows.slice(1) : [];
          onChange({ headers, rows: dataRows, raw: text });
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  };

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: csvAccept,
    maxCount: 1,
    beforeUpload: (file) => {
      handleFile(file).catch((err) => {
        console.error(err);
      });
      return false; // prevent actual upload
    },
    onRemove: () => onChange(null),
    showUploadList: true,
  };

  const previewRows = value ? value.rows.slice(0, 5) : [];
  const columns =
    value?.headers.map((h, i) => ({
      title: h,
      dataIndex: i,
      key: String(i),
      ellipsis: true,
      render: (v: string) => v ?? '—',
    })) ?? [];

  return (
    <div style={{ padding: '8px 0' }}>
      <Dragger {...uploadProps}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined style={{ color: token.colorPrimary, fontSize: 48 }} />
        </p>
        <p className="ant-upload-text">Click or drag a CSV file here</p>
        <p className="ant-upload-hint">
          Only .csv files. First row will be used as column headers.
        </p>
      </Dragger>

      {value && (
        <>
          <Alert
            style={{ marginTop: 16 }}
            message={`Detected ${value.headers.length} columns, ${value.rows.length} data rows`}
            type="info"
            showIcon
          />
          <h4 style={{ marginTop: 16, marginBottom: 8 }}>Preview (first 5 rows)</h4>
          <Table
            size="small"
            columns={columns}
            dataSource={previewRows.map((row, i) => ({
              key: i,
              ...Object.fromEntries(row.map((v, j) => [j, v])),
            }))}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        </>
      )}
    </div>
  );
};
