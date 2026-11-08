// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import type { ActionTarget } from '../actions/targets';
import { Deployer } from './deploy';
import { isMember, memberOf, remotePathOf } from './layout';
import { ProjectDeps } from './pull';
import { relativeTo } from './store';

/** An action on a local file: what it runs against once the file is deployed. */
export interface LocalRun {
  /** The deployed member or stream file. */
  target: ActionTarget;
  /** `&LIBRARY` (and, for a member, `&SRCLIB`): the project's target library. */
  library?: string;
  /** The local file. */
  uri: vscode.Uri;
  /** Deploys the file, with the conflict check; true when the system now has it. */
  deploy(): Promise<boolean>;
}

/**
 * Local files as action targets. A file of a library project is the
 * member it deploys to: `&LIBRARY` and `&SRCLIB` the target library,
 * `&SRCFILE` its directory, `&NAME` and `&TYPE` its name and extension;
 * a file of an IFS project is the stream file it deploys to, `&FULLPATH`
 * that path. `&CURLIB` stays the connection's.
 */
export class LocalActions {
  constructor(
    private readonly deps: ProjectDeps,
    private readonly deployer: Deployer,
  ) {}

  /** What `uri` runs as; undefined when it is in no project; an error message when it cannot be deployed. */
  async resolve(uri: vscode.Uri): Promise<LocalRun | string | undefined> {
    await this.deps.projects.ready;
    const project = this.deps.projects.projectFor(uri);
    if (!project) {
      return undefined;
    }
    const rel = relativeTo(project.folder.uri, uri);
    if (!rel) {
      return undefined;
    }
    const connection = this.deps.projects.connectionOf(project);
    const deploy = async () => {
      const r = await this.deployer.deploy(project, 'file', rel);
      return r !== undefined && r.deployed.includes(rel);
    };
    const t = project.config.target;
    if (t.kind === 'path') {
      return { target: { environment: 'file', connection, path: remotePathOf(t.path, rel) }, uri, deploy };
    }
    const m = memberOf(rel);
    if (!isMember(m)) {
      return `${rel} is ${m.reason}, so it is no member of ${t.library}`;
    }
    return {
      target: { environment: 'member', connection, library: t.library, file: m.file, member: m.member, type: m.type, ext: m.ext },
      library: t.library,
      uri,
      deploy,
    };
  }
}
