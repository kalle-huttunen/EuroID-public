/**
 * Policy actions name only systems the backend has a connector for. The node rail used to offer
 * "Create Jira Account" and the action drawer Salesforce, neither of which EuroID registers, and
 * the drawer lacked Active Directory, which the rail's "Assign AD Group" targets. Both now take
 * their targets from the connector registry (connector-registry.test.ts pins it to the backend).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { ConfigProvider, Form } from 'antd';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { NodePalette } from '../NodePalette';
import { ActionConfig } from '../components/ActionConfig';
import { POLICY_ACTION_TARGETS } from '../shared';
import type { PolicyNodeTemplate } from '../types/blueprint-canvas.types';

const TARGET_VALUES = POLICY_ACTION_TARGETS.map((t) => t.value);

describe('policy action targets', () => {
  it('the node rail offers actions only on registered target connectors or all systems', () => {
    const onAdd = vi.fn<(template: PolicyNodeTemplate) => void>();
    renderWithProviders(<NodePalette onAdd={onAdd} />);

    const actions = within(screen.getByRole('list', { name: 'Actions' })).getAllByRole('button');
    actions.forEach((button) => fireEvent.click(button));

    const added = onAdd.mock.calls.map(([template]) => template.data);
    expect(added).toHaveLength(actions.length);
    for (const data of added) {
      expect(TARGET_VALUES, String(data.targetSystem)).toContain(data.targetSystem);
    }
    expect(actions.map((b) => b.textContent)).not.toContain('Create Jira Account');
    expect(added).toContainEqual({ targetSystem: 'ad', actionType: 'assign_group' });
    expect(added).toContainEqual({ targetSystem: 'entra-id', actionType: 'assign_group' });
  });

  function Drawer({ targetSystem }: { targetSystem: string }) {
    const [form] = Form.useForm();
    const node = {
      id: 'action-1',
      type: 'action',
      position: { x: 0, y: 0 },
      data: { targetSystem, actionType: 'assign_group' },
    } as Node;
    React.useEffect(() => {
      form.setFieldsValue({ targetSystem, actionType: 'assign_group' });
    }, [form, targetSystem]);
    return <ActionConfig selectedNode={node} form={form} onSave={vi.fn()} onClose={vi.fn()} />;
  }

  it('the action drawer summary names the action and target as the selects show them', async () => {
    // 2.0co: it read "assign_group assign_group in ad" above a select showing Active Directory.
    renderWithProviders(<Drawer targetSystem="ad" />);

    const summary = await screen.findByText(/^When/);
    expect(summary).toHaveTextContent(
      'When (no conditions), then Assign Group in Active Directory.',
    );
    expect(summary).not.toHaveTextContent('assign_group');
  });

  it('the action drawer summary follows a changed target before it is saved', async () => {
    const { container } = renderWithProviders(
      <ConfigProvider virtual={false}>
        <Drawer targetSystem="ad" />
      </ConfigProvider>,
    );
    await screen.findByTitle('Active Directory');

    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
    await screen.findByRole('listbox');
    const okta = POLICY_ACTION_TARGETS.find((t) => t.value === 'okta')!.label;
    fireEvent.click(
      container.ownerDocument.querySelector(`.ant-select-item-option[title="${okta}"]`)!,
    );

    expect(await screen.findByText(/^When/)).toHaveTextContent(`then Assign Group in ${okta}.`);
  });

  it('the action drawer lists the registered target connectors and All Systems, no others', async () => {
    // Without virtual scrolling, so jsdom renders every option of the dropdown.
    const { container } = renderWithProviders(
      <ConfigProvider virtual={false}>
        <Drawer targetSystem="ad" />
      </ConfigProvider>,
    );

    // The AD action the rail adds shows by its connector name.
    expect(await screen.findByTitle('Active Directory')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
    await screen.findByRole('listbox');
    const offered = Array.from(
      container.ownerDocument.querySelectorAll('.ant-select-item-option'),
    ).map((option) => option.getAttribute('title'));

    expect(offered).toEqual(POLICY_ACTION_TARGETS.map((t) => t.label));
    expect(offered).not.toContain('Salesforce');
    expect(offered).toContain('All Systems');
  });
});
