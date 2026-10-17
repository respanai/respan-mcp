import { describe, expect, it } from 'vitest';
import {
  ProjectSelectionError,
  resolveTeamId,
  toProjects,
} from '../lib/account/projects.js';

const ACME = {
  id: 11,
  role: 'admin',
  organization: { unique_organization_id: 'org-acme', name: 'Acme' },
};
const GLOBEX = {
  id: 22,
  role: 'member',
  organization: { unique_organization_id: 'org-globex', name: 'Globex' },
};
// Sibling org in the same company that the user has no membership in — the
// backend synthesizes these with id/role null (organization/utils: get_visible_teams_for_user).
const SIBLING = {
  id: null,
  role: null,
  organization: { unique_organization_id: 'org-sibling', name: 'Initech' },
};

function projects() {
  return toProjects([ACME, GLOBEX, SIBLING], 'org-globex');
}

describe('toProjects', () => {

  it('marks nothing current when the active project is unknown', () => {
    expect(toProjects([ACME], undefined).some((o) => o.is_current)).toBe(false);
  });
});

describe('resolveTeamId', () => {
  it.each([
    ['name', 'Acme'],
    ['name in a different case', 'aCMe'],
    ['project_id', 'org-acme'],
    ['team_id', '11'],
  ])('resolves by %s', (_label, selector) => {
    expect(resolveTeamId(projects(), selector)).toBe(11);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveTeamId(projects(), '  Acme ')).toBe(11);
  });

  it('refuses a project the user is not a member of', () => {
    expect(() => resolveTeamId(projects(), 'Initech'))
      .toThrow(ProjectSelectionError);
    expect(() => resolveTeamId(projects(), 'Initech'))
      .toThrow(/not a member/);
  });
});
