// Every repository the UI team owns, with the group it belongs to.
//
// Mirrored from config/repos.txt in the interrupt-duty repository, which is itself mirrored
// from the Confluence "GitHub Repositories" page. The categories are the section headings
// there, so a repository moving group is a one-line change in both places.
//
// Not every one of these is charted. The history builder keeps the ones whose Dependabot
// alerts the token can actually read and lists the rest as skipped, because a repository
// missing from a chart should be a stated absence rather than a silent one.
export interface TrackedRepo {
  repo: string;
  category: string;
}

export const TRACKED_REPOS: TrackedRepo[] = [
  { repo: 'rancher/dashboard', category: 'Rancher' },
  { repo: 'rancher/ui', category: 'Rancher' },
  { repo: 'rancher/api-ui', category: 'Rancher' },
  { repo: 'rancher/icons', category: 'Rancher' },
  { repo: 'rancher/ui-plugin-charts', category: 'Rancher' },
  { repo: 'rancher/ui-plugin-examples', category: 'Rancher' },
  { repo: 'rancher/partner-extensions', category: 'Rancher' },
  { repo: 'rancher/storybook', category: 'Rancher' },
  { repo: 'rancher/ui-internal-tools', category: 'Rancher' },
  { repo: 'rancher/ui-dynamic-content', category: 'Rancher' },
  { repo: 'rancher/longhorn-ui-extension', category: 'Rancher' },
  { repo: 'rancher/virtual-clusters-ui', category: 'Prime UI Extensions' },
  { repo: 'rancher/elemental-ui', category: 'Prime UI Extensions' },
  { repo: 'rancher/capi-ui-extension', category: 'Prime UI Extensions' },
  { repo: 'rancher/kubewarden-ui', category: 'Prime UI Extensions' },
  { repo: 'rancher/rancher-ai-ui', category: 'Prime UI Extensions' },
  { repo: 'rancher/ali-ui', category: 'Prime UI Extensions' },
  { repo: 'rancher/prov-capi-ui-extensions', category: 'Prime UI Extensions' },
  { repo: 'harvester/harvester-ui-extension', category: 'Harvester/SUSE Virtualisation' },
  { repo: 'longhorn/longhorn-ui', category: 'Longhorn/SUSE Storage' },
  { repo: 'neuvector/manager', category: 'NeuVector' },
  { repo: 'neuvector/manager-ext', category: 'NeuVector' },
  { repo: 'neuvector/vuldb-explorer', category: 'NeuVector' },
  { repo: 'rancher/security-ui-exts', category: 'SUSE Security' },
  { repo: 'rancher-sandbox/dashboard', category: 'Sandbox' },
  { repo: 'rancher-sandbox/rancher-ai-llm-mock', category: 'Sandbox' },
];
