import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from './contract.js';
import { graphView } from './ui/graph.js';
import { computeView } from './ui/compute.js';
import { runtimeView } from './ui/runtime.js';

/** Native pages use the same validated operations and connection as agent tools. */
export default defineControlUiPlugin({
  id: 'viable-system-claw',
  activate(host) {
    const feature = createFeatureClient(contract, host);
    const dispose = [
      host.ui.registerPage({ id: 'organization', label: 'Organization', mount: graphView(feature) }),
      host.ui.registerPage({ id: 'compute', label: 'Compute allocation', mount: computeView(feature) }),
      host.ui.registerPage({ id: 'runtime', label: 'Runtime', mount: runtimeView(feature) }),
      host.ui.registerNavigation({ id: 'organization', label: 'Organization', icon: 'network', page: { id: 'organization' }, order: 40 }),
      host.ui.registerNavigation({ id: 'compute', parent: 'organization', label: 'Compute allocation', icon: 'cpu', page: { id: 'compute' }, order: 41 }),
      host.ui.registerNavigation({ id: 'runtime', parent: 'organization', label: 'Runtime', icon: 'activity', page: { id: 'runtime' }, order: 42 }),
    ];
    return () => { for (const unregister of dispose.reverse()) unregister(); };
  },
});
