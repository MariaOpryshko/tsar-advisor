'use strict'

import * as vscode from 'vscode';
import * as path from 'path';
import {decodeLocation, encodeLocation,
  projectLink, moveToCode, commandLink, numberHtml, styleLink,
  unavailableHtml, waitHtml, checkTrait, getStrLocation} from './functions';
import * as log from './log';
import * as msg from './messages';
import {ProjectEngine, Project,
  ProjectContentProvider, ProjectContentProviderState} from './project';

/**
 * State of a loop tree content provider.
 */
export class LoopTreeProviderState implements ProjectContentProviderState {
  private _provider: LoopTreeProvider;
  constructor(provider: LoopTreeProvider) { this._provider = provider; }
  response: any;
  get provider (): LoopTreeProvider { return this._provider;}
  dispose(): any {}
}

/**
 * Provides a general information about analyzed project.
 */
export class LoopTreeProvider implements ProjectContentProvider{
  static scheme = "tsar-looptree";
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  private _engine: ProjectEngine;
  static Attr = {
    LibFunc: 1,
    NoReturn: 2
  }

  constructor(engine: ProjectEngine) { this._engine = engine; }
  dispose() { this._onDidChange.dispose(); }

  /**
   * Returns new description of a project content provider state.
   */
  state(): LoopTreeProviderState {
    return new LoopTreeProviderState(this);
  }

  /**
   * Informs listeners about content changes.
   *
   * If this provider has been registered after call of this method
   * provideTextDocumentContent() will be called to update visible content.
   */
  update(project: Project) {
    this._onDidChange.fire(encodeLocation(LoopTreeProvider.scheme, project.uri));
  }

  /**
   * Returns event to subscribe for content changes.
   */
  get onDidChange(): vscode.Event<vscode.Uri> {
    return this._onDidChange.event;
  }

  /**
   * Provides html with general information about analyzed project.
   */
  public provideTextDocumentContent(uri: vscode.Uri): Thenable<string>|string {
    let prjUri = <vscode.Uri>decodeLocation(uri).shift();
    let project = this._engine.project(prjUri);
    if (project === undefined)
      return unavailableHtml(prjUri);
    let state = <LoopTreeProviderState>project.providerState(LoopTreeProvider.scheme);
    if (project.response !== undefined &&
        project.response instanceof msg.FunctionList)
      state.response = project.response;
    let response = project.response;
    return new Promise((resolve, reject) => {
      if (response !== undefined && response instanceof msg.FunctionList) {
        return resolve(this._provideFunctionList(project, response));
      } else if (response !== undefined && response instanceof msg.LoopTree) {
        return resolve(this._provideLoopTree(project, response));
      } else if (state.response !== undefined) {
        return resolve(this._provideFunctionList(project, state.response))
      }
      return resolve(waitHtml(log.FunctionList.title, project));
    });
  }

  private _provideFunctionList(project: Project, funclst: msg.FunctionList): string {
    let bootstrap = vscode.Uri.file(
      path.resolve(__dirname, '..', '..', 'node_modules', 'bootstrap', 'dist'));
    let jquery = vscode.Uri.file(
      path.resolve(__dirname, '..', '..', 'node_modules', 'jquery', 'dist'));
    let bootstrapHeader =
      `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="description" content="">
          <meta name="author" content="">
          <title>Functions and Loop Tree</title>
          <link href="${bootstrap}/css/bootstrap.min.css" rel="stylesheet">
          <script src="${jquery}/jquery.min.js"></script>
          <script src="${bootstrap}/js/bootstrap.min.js"></script>
        </head>
        <body>`;
    let bootstrapFooter = `</body></html>`;
    let body =
      `   <table class="table table-hover">
            <tr><th>Functions and Loops</th><th>Is Analyzed</th><th>Canonical</th><th>Perfect</th><th>Exit</th>
            <th>Level</th><th>Input/Output</th><th>Type</th><th>Readonly</th><th>UnsafeCFG</th></tr>`;
    let funclen = funclst.Functions.length;
    for (let i = 0; i < funclen; i++) {
      let func = funclst.Functions[i];
      let looplen = func.Loops.length;
      let linkInOut = {command: 'tsar.callee.func', project: project, title: 'CalleeFunc',
          query: JSON.stringify({ID: '', FuncID: func.ID, Attr: LoopTreeProvider.Attr.LibFunc})};
      let linkNoReturn = {command: 'tsar.callee.func', project: project, title: 'CalleeFunc',
          query: JSON.stringify({ID: '', FuncID: func.ID, Attr: LoopTreeProvider.Attr.NoReturn})};
      body += `<tr><td>`;
      if (looplen) {
        if (func.Loops[0].Hide)
          body += `${commandLink('tsar.expcol.looptree', project, 'Expand', '+',
              JSON.stringify({FuncID: func.ID, LoopID: 0, Hide: false}))}`;
        else
          body += `${commandLink('tsar.expcol.looptree', project, 'Collapse', '&minus;',
              JSON.stringify({FuncID: func.ID, LoopID: 0, Hide: true}))}`;
      } else if (func.Traits.Loops == "Yes") {
        body += `${commandLink('tsar.loop.tree', project, 'Loops', '+', JSON.stringify({ID: func.ID}))}`;
      }
      body += `${func.Name} ` + getStrLocation(project, func.StartLocation) + ` - ` +
          getStrLocation(project, func.EndLocation) + `</td>
          <td>&#10003</td>
          <td>N/A</td>
          <td>N/A</td>
          <td>N/A</td>
          <td class='level'>0</td>` +
          checkTrait(func.Traits.InOut, linkInOut)
          +`<td>N/A</td>` +
          checkTrait(func.Traits.Readonly) +
          checkTrait(func.Traits.UnsafeCFG, linkNoReturn) + `</tr>`;
      for (let j = 0; j < looplen; j++) {
        let loop = func.Loops[j];
        if (loop.Hide == undefined && loop.Level != 1)
          loop.Hide = true;
        else if (loop.Hide == undefined && loop.Level == 1)
          loop.Hide = false;
      }
      let Hide = false;
      let PrevLevel = 0;
      for (let j = 0; j < looplen; j++) {
        let loop = func.Loops[j];
        if (Hide && loop.Level > PrevLevel)
          continue;
        if (loop.Hide) {
          Hide = true;
          PrevLevel = loop.Level;
          continue;
        }
        Hide = false;
        linkInOut.query = JSON.stringify(
            {ID: '', FuncID: func.ID, LoopID: loop.ID, Attr: LoopTreeProvider.Attr.LibFunc});
        linkNoReturn.query = JSON.stringify(
            {ID: '', FuncID: func.ID, LoopID: loop.ID, Attr: LoopTreeProvider.Attr.NoReturn});
        body += `<tr><td>`;
        for (let k = 0; k < loop.Level; k++) {
          body += `&emsp;`;
        }
        if (j != looplen - 1 && func.Loops[j + 1].Level > loop.Level) {
          if (func.Loops[j + 1].Hide)
            body += `${commandLink('tsar.expcol.looptree', project, 'Expand', '+',
                JSON.stringify({FuncID: func.ID, LoopID: loop.ID, Hide: false}))}`;
          else
            body += `${commandLink('tsar.expcol.looptree', project, 'Collapse', '&minus;',
                JSON.stringify({FuncID: func.ID, LoopID: loop.ID, Hide: true}))}`;
        }
        body += `loop in ${func.Name} at ` +
            getStrLocation(project, loop.StartLocation) + ` - ` +
            getStrLocation(project, loop.EndLocation) + `</td>` +
            checkTrait(loop.Traits.IsAnalyzed);
        if (loop.Traits.IsAnalyzed == "Yes") {
          body += checkTrait(loop.Traits.Canonical) + checkTrait(loop.Traits.Perfect);
        } else {
          body += `<td>N/A</td><td>N/A</td>`;
        }
        if (loop.Exit > 1) {
          body += `<td>${commandLink('tsar.callee.func', project,
              'CalleeFunc', `${loop.Exit}`, linkNoReturn.query)}</td>`;
        } else {
          body += `<td>${loop.Exit}</td>`;
        }
        body += `<td>${loop.Level}</td>` +
            checkTrait(loop.Traits.InOut, linkInOut) +
            `<td>${loop.Type}</td>
            <td>N/A</td>
            <td>N/A</td></tr>`;
      }
    }
    body += `</table>`;
    return bootstrapHeader + body + bootstrapFooter;
  }

  private _provideLoopTree(project: Project, func: msg.LoopTree): string {
    let state = <LoopTreeProviderState>project.providerState(LoopTreeProvider.scheme);
    let funclist: msg.FunctionList = state.response;
    let funclen = funclist.Functions.length;
    for (let i = 0; i < funclen; i++) {
      if (funclist.Functions[i].ID != func.FunctionID)
        continue;
      funclist.Functions[i].Loops = func.Loops;
      return this._provideFunctionList(project, funclist);
    }
    return this._provideFunctionList(project, funclist);
  }
}
