// The vulnerability console: one page, one product, one board of what is actionable.
//
// The extension owns no agent of its own. Everything AI in it runs through codyrancher/agents,
// which puts one claude pod in the cluster and offers its conversations on `window.__agents`;
// the workspace a fix happens in is an apps-plus installation. The page says so when either is
// missing, because without them there is nothing to press.
import { IPlugin } from '@shell/core/types';
import { NAV_ICON } from './icon.generated';

export default function(plugin: IPlugin): void {
  plugin.metadata = require('./package.json');

  plugin.addProduct({
    name:  'vuln-console',
    label: 'Vulnerabilities',
    // A data URI rather than a required file. Rancher renders this through an <img> and a built
    // extension is served from a path chosen by whoever installed it, so an emitted asset's URL
    // is not something this build gets to know - and the icon would 404 in half the installs.
    sideBar: { icon: { svg: NAV_ICON as unknown as () => string } },
    // Lazily, so the board is a chunk of its own rather than part of a bundle every page of the
    // dashboard loads.
    component: () => import('./pages/VulnPage.vue'),
  });
}
