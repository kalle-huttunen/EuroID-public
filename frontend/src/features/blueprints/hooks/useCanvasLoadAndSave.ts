/**
 * useCanvasLoadAndSave — Load canvas on mount, save, correlation save, node update save.
 * The canvas holds the connector graph (component state) and the policy condition/action
 * draft (policy-draft-store); both are saved together and split again on load.
 * Extracted from BlueprintCanvas for separation of concerns.
 */
import { useState, useCallback, useEffect, useMemo, useRef, createElement } from 'react';
import { Button } from 'antd';
import { Node, Edge } from '@xyflow/react';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { initialNodes, initialEdges, withBrainNode } from '../canvas';
import { reconstructNodeLabel, serializeLabel } from '../utils/reconstruct-label';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import type { PolicyEdge, PolicyNode } from '@stores/policy-draft-store';
import type { CorrelationConfigFormValues } from '../brain-config/IdentityCorrelationTab';
import type { CorrelationRule } from '../../../interfaces';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

export type ConnectorConfigsMap = Record<string, Record<string, unknown>>;

const isPolicyNodeType = (type: string | undefined) => type === 'condition' || type === 'action';

const toPolicyEdge = ({ id, source, target, data }: Edge | PolicyEdge): PolicyEdge => ({
  id,
  source,
  target,
  ...(data && { data: data as PolicyEdge['data'] }),
});

/**
 * POST /blueprints/save body: the connector graph with node labels as `{ text, icon }` (JSON
 * cannot carry an element), then the policy draft's condition and action nodes and their edges.
 */
function canvasBody(
  nodes: Node[],
  edges: Edge[],
  connectorConfigs: ConnectorConfigsMap,
  draftNodes: PolicyNode[],
  draftEdges: PolicyEdge[],
  revision: number | undefined,
) {
  return {
    // The revision loaded (or last saved): the API refuses the save (409) when it is not the
    // stored one, so a save never overwrites someone else's
    ...(revision !== undefined && { revision }),
    nodes: [
      ...nodes.map((node) =>
        node.data?.label === undefined
          ? node
          : { ...node, data: { ...node.data, label: serializeLabel(node.data.label) } },
      ),
      ...draftNodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
    ],
    edges: [...edges, ...draftEdges.map(toPolicyEdge)],
    viewport: { x: 0, y: 0, zoom: 1 },
    connectorConfigs,
  };
}

/** POST /blueprints/save refused because someone saved the canvas after it was loaded. */
const isRevisionConflict = (error: unknown) =>
  (error as { response?: { status?: number } } | undefined)?.response?.status === 409;

/** A saved canvas split into the connector graph and the policy draft (nodes and edges between them). */
function splitCanvas(nodes: Node[], edges: Edge[]) {
  const policyIds = new Set(nodes.filter((n) => isPolicyNodeType(n.type)).map((n) => n.id));
  const isPolicyEdge = (e: Edge) => policyIds.has(e.source) && policyIds.has(e.target);
  return {
    nodes: nodes.filter((n) => !policyIds.has(n.id)),
    edges: edges.filter((e) => !isPolicyEdge(e)),
    draftNodes: nodes
      .filter((n) => policyIds.has(n.id))
      .map(
        ({ id, type, position, data }): PolicyNode => ({
          id,
          type: type as PolicyNode['type'],
          position,
          data: data ?? {},
        }),
      ),
    draftEdges: edges.filter(isPolicyEdge).map(toPolicyEdge),
  };
}

export interface UseCanvasLoadAndSaveParams {
  setNodes: (nodes: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  nodes: Node[];
  edges: Edge[];
  api: ReturnType<typeof import('antd').notification.useNotification>[0];
}

export function useCanvasLoadAndSave({
  setNodes,
  setEdges,
  nodes,
  edges,
  api,
}: UseCanvasLoadAndSaveParams) {
  const [connectorConfigs, setConnectorConfigs] = useState<ConnectorConfigsMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  /** Why the saved canvas could not be loaded (the API's message); null once it loaded. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const { draftNodes, draftEdges, loadDraft, markClean } = usePolicyDraftStore();
  /** The canvas revision loaded or last saved (GET /latest, POST /save answer it). */
  const revision = useRef<number | undefined>(undefined);

  const brainConfigForDrawer = useMemo((): CorrelationConfigFormValues | null => {
    const raw = (connectorConfigs['euroid-core'] as Record<string, unknown>)?.correlationConfig as
      | Record<string, unknown>
      | undefined;
    if (!raw) return null;
    const overrides = raw.fieldMasteryOverrides as Record<string, string[]> | undefined;
    const fieldMasteryOverrides: Record<string, string> = {};
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        fieldMasteryOverrides[k] = Array.isArray(v) ? v[0] : String(v);
      }
    }
    return {
      rules: (raw.rules as CorrelationRule[]) ?? [{ strategy: 'email' }],
      conflictAction: (raw.conflictAction as 'auto-link' | 'review') ?? 'review',
      fieldMasteryOverrides,
      hrWriteback: (raw.hrWriteback as boolean) ?? false,
      targetWriteback: (raw.targetWriteback as boolean) ?? true,
    };
  }, [connectorConfigs]);

  /**
   * Load the saved canvas, or the default layout when nothing is saved. A canvas that cannot be
   * loaded is not replaced by the defaults (a Save would then overwrite the stored one): the page
   * shows `loadError` with Retry (this function) and offers no Save until a load succeeds.
   */
  const loadCanvas = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { data } = await axiosInstance.get(`${API_BASE}/blueprints/latest`);
      revision.current = typeof data.revision === 'number' ? data.revision : undefined;
      // A saved canvas loads as saved, also one without nodes: its connectorConfigs (the Brain's
      // correlation rule among them) are part of it, and a Save of the defaults would overwrite
      // them. `lastSaved` is the saved document's updatedAt; the API sends none when nothing is
      // saved. A canvas with nodes counts as saved without it, as it always did.
      const savedNodes = (data.success && data.data?.nodes) || [];
      if (data.success && (data.lastSaved || savedNodes.length > 0)) {
        const saved = splitCanvas(savedNodes as Node[], (data.data.edges ?? []) as Edge[]);
        const reconstructedNodes = saved.nodes.map((node) => ({
          ...node,
          data: { ...node.data, label: reconstructNodeLabel(node) },
        }));
        // The Brain node is the only way to the correlation and mastery settings: keep it.
        setNodes(withBrainNode(reconstructedNodes));
        setEdges(saved.edges);
        // The canvas shows what is saved: an unsaved draft from an earlier visit is dropped,
        // like unsaved connector changes.
        loadDraft(saved.draftNodes, saved.draftEdges);
        setConnectorConfigs(data.data.connectorConfigs || {});
      } else {
        setNodes(initialNodes as Node[]);
        setEdges(initialEdges as Edge[]);
        loadDraft([], []);
      }
    } catch (error) {
      console.error('[BlueprintCanvas] Failed to load canvas:', error);
      const reached = !!(error as { response?: unknown } | undefined)?.response;
      setLoadError(
        reached
          ? apiErrorMessage(error, 'The saved canvas could not be loaded. Nothing was changed.')
          : 'The server could not be reached, so the saved canvas was not loaded. Nothing was ' +
              'changed.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [setNodes, setEdges, loadDraft]);

  useEffect(() => {
    loadCanvas();
    // Once on mount (Retry calls loadCanvas again): its dependencies may change identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Save the whole canvas, policy draft included; a successful save leaves the draft clean. A
   * save refused because someone saved the canvas since it was loaded (409) tells the admin to
   * reload, with a Reload button, and is rethrown: the callers show no error of their own then.
   */
  const postCanvas = useCallback(
    async (canvasNodes: Node[], configs: ConnectorConfigsMap) => {
      // Never over a canvas that failed to load: what is shown is not what is stored
      if (loadError) throw new Error(loadError);
      try {
        const { data } = await axiosInstance.post(
          `${API_BASE}/blueprints/save`,
          canvasBody(canvasNodes, edges, configs, draftNodes, draftEdges, revision.current),
        );
        if (typeof data.revision === 'number') revision.current = data.revision;
        if (data.success) markClean();
        return data;
      } catch (error) {
        if (isRevisionConflict(error)) {
          api.error({
            key: 'canvas-revision-conflict',
            message: 'Canvas changed by someone else',
            description: apiErrorMessage(
              error,
              'Someone saved the canvas after you loaded it. Nothing was saved: reload it.',
            ),
            duration: 0,
            placement: 'top',
            actions: createElement(
              Button,
              { type: 'primary', size: 'small', onClick: () => void loadCanvas() },
              'Reload',
            ),
          });
        }
        throw error;
      }
    },
    [edges, draftNodes, draftEdges, markClean, loadError, api, loadCanvas],
  );

  const handleSaveCanvas = useCallback(async () => {
    setIsSaving(true);
    try {
      const data = await postCanvas(nodes, connectorConfigs);
      if (data.success) {
        api.success({
          message: 'Canvas Saved',
          description: `Configuration saved with ${data.nodeCount} nodes`,
          placement: 'top',
        });
      }
    } catch (error) {
      console.error('[BlueprintCanvas] Failed to save canvas:', error);
      if (isRevisionConflict(error)) return; // postCanvas told the admin to reload
      api.error({
        message: 'Save Failed',
        description: apiErrorMessage(error, 'Could not save canvas configuration'),
        placement: 'top',
      });
    } finally {
      setIsSaving(false);
    }
  }, [nodes, connectorConfigs, api, postCanvas]);

  const handleCorrelationSave = useCallback(
    async (values: CorrelationConfigFormValues) => {
      const fieldMasteryOverrides: Record<string, string[]> = {};
      if (values.fieldMasteryOverrides) {
        for (const [k, v] of Object.entries(values.fieldMasteryOverrides)) {
          if (v && v !== '__default__') fieldMasteryOverrides[k] = [v];
        }
      }
      const newConnectorConfigs = {
        ...connectorConfigs,
        'euroid-core': {
          ...connectorConfigs['euroid-core'],
          correlationConfig: {
            rules: values.rules,
            conflictAction: values.conflictAction,
            fieldMasteryOverrides,
            hrWriteback: values.hrWriteback ?? false,
            targetWriteback: values.targetWriteback ?? true,
          },
        },
      };
      setIsSaving(true);
      try {
        const data = await postCanvas(nodes, newConnectorConfigs);
        // Kept only once saved: a refused value in the state would go out with every later Save
        if (data.success) {
          setConnectorConfigs((prev) => ({
            ...prev,
            'euroid-core': newConnectorConfigs['euroid-core'],
          }));
          api.success({
            message: 'Configuration Saved',
            description: 'Identity correlation settings saved',
            placement: 'top',
          });
        }
      } catch (error) {
        console.error('[BlueprintCanvas] Failed to save correlation config:', error);
        // The Identity Correlation tab reports it with the API's message (a refused Field
        // Mastery owner says what to change), and claims no success
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [nodes, connectorConfigs, api, postCanvas],
  );

  const handleUpdateNodeDataAndSave = useCallback(
    async (nodeId: string, newData: Record<string, unknown>) => {
      const updatedNodes = nodes.map((node) =>
        node.id === nodeId ? { ...node, data: newData } : node,
      );
      setIsSaving(true);
      try {
        const data = await postCanvas(updatedNodes, connectorConfigs);
        // The node shows the new data once saved; a refused save leaves the saved data (the
        // drawer keeps the form for the admin to correct)
        if (data.success) {
          setNodes((prev) =>
            prev.map((node) => (node.id === nodeId ? { ...node, data: newData } : node)),
          );
          api.success({
            message: 'Configuration Saved',
            description: 'Node configuration saved and persisted',
            placement: 'top',
          });
        }
      } catch (error) {
        console.error('[BlueprintCanvas] Failed to save canvas:', error);
        if (isRevisionConflict(error)) return; // postCanvas told the admin to reload
        api.error({
          message: 'Save Failed',
          description: apiErrorMessage(error, 'Could not save node configuration'),
          placement: 'top',
        });
      } finally {
        setIsSaving(false);
      }
    },
    [nodes, connectorConfigs, api, postCanvas, setNodes],
  );

  return {
    connectorConfigs,
    setConnectorConfigs,
    isLoading,
    loadError,
    retryLoad: loadCanvas,
    isSaving,
    brainConfigForDrawer,
    handleSaveCanvas,
    handleCorrelationSave,
    handleUpdateNodeDataAndSave,
  };
}
