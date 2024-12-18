//===--- project.ts ------------ Project Engine ------------- TypeScript --===//
//
//                           TSAR Advisor (SAPFOR)
//
// This implements active project controller and single project representation.
//
//===----------------------------------------------------------------------===//

'use strict';

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import {establishVSEnvironment, establishLinuxEnvironment} from './functions';
import {ProjectProvider} from './general';
import * as log from './log';
import * as msg from './messages';
import {createInterface, Interface} from 'readline';
import * as which from 'which';

type ToolT = {};

/**
 * This controls all currently active projects evaluated by the extension.
 */
export class ProjectEngine {
  private _projects = new Map<string, Project>();
  private _parser = new msg.Parser(
    msg.Diagnostic,
    msg.FileList,
    msg.Statistic,
    msg.FunctionList,
    msg.LoopTree,
    msg.CalleeFuncList,
    msg.AliasTree
  );
  private _context: vscode.ExtensionContext;
  private _providers = new Map<string, ProjectContentProvider>();
  private _environment = {};

  /**
   * Build internal identifier for a specified project uri.
   */
  private static _projectID(uri: vscode.Uri): string {
    return vscode.Uri.file(uri.path).fsPath.toString();
  }

  /**
   * Return true if a specified object represent URI.
   *
   */
  private static _isUri(obj: vscode.TextDocument | Project | vscode.Uri):
     obj is vscode.Uri {
    return (obj as vscode.Uri).with !== undefined;
  }

  /**
   * Update compilation environment according to the user configuration.
   */
  private _configureCompilerUserEnv() {
    let userConfig = vscode.workspace.getConfiguration(log.Extension.id);
    if (userConfig.has("compilation.cIncludePath")) {
      let list: [] = userConfig.get('compilation.cIncludePath');
      if (this._environment['C_INCLUDE_PATH'] === undefined)
        this._environment['C_INCLUDE_PATH'] = list.join(':');
      else
        this._environment['C_INCLUDE_PATH'] += `:${list.join(':')}`;
    }
    if (userConfig.has("compilation.c++IncludePath")) {
      let list: [] = userConfig.get('compilation.c++IncludePath');
      if (this._environment['CPLUS_INCLUDE_PATH'] === undefined)
        this._environment['CPLUS_INCLUDE_PATH'] = list.join(':');
      else
        this._environment['CPLUS_INCLUDE_PATH'] += `:${list.join(':')}`;
    }
    log.Log.logs[0].write(
      log.Message.environment.replace('{0}', '{'
        + `"C_INCLUDE_PATH": "${this._environment['C_INCLUDE_PATH']}",`
        + `"CPLUS_INCLUDE_PATH": "${this._environment['CPLUS_INCLUDE_PATH']}"`
        + '}'));
  }

  private _configureEnvironment() {
    let onerror = (err) => {
      if (err instanceof Error)
        log.Log.logs[0].write(
          log.Message.environment.replace('{0}', err.message));
      else
        log.Log.logs[0].write(
          log.Message.environment.replace('{0}', err));
    };
    let userConfig = vscode.workspace.getConfiguration(log.Extension.id);
    if (userConfig.get('advanced.environment.enabled') === true) {
      let compilerEnv;
      if (!process.platform.match(/^win/i))
        compilerEnv = establishLinuxEnvironment(onerror, userConfig.get('advanced.environment.linuxCCompiler'));
      else
        compilerEnv = establishVSEnvironment(onerror);
      if (compilerEnv[0] === undefined) {
        log.Log.logs[0].write(
          log.Message.environment.replace('{0}', log.Error.environment));
        vscode.window.showWarningMessage(
          `${log.Extension.displayName}: ${log.Error.environment}`);
        this._environment = process.env;
      } else {
        log.Log.logs[0].write(
          log.Message.environment.replace('{0}', compilerEnv[1]));
        this._environment = compilerEnv[0];
      }
    }
    if (!process.platform.match(/^win/i)) {
      if (this._environment['LD_LIBRARY_PATH'] === undefined)
        this._environment['LD_LIBRARY_PATH'] = __dirname;
      else
        this._environment['LD_LIBRARY_PATH'] += `:${__dirname}`;
      log.Log.logs[0].write(
        log.Message.environment.replace('{0}',
         `{"LD_LIBRARY_PATH": "${this._environment['LD_LIBRARY_PATH']}"}`));
    }
    this._configureCompilerUserEnv();
  }

  /**
   * Create engine is a specified extension context.
   */
  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._configureEnvironment();
    this._context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${log.Extension.id}.compilation`))
        this._configureCompilerUserEnv();
      else if (e.affectsConfiguration(`${log.Extension.id}.advanced.environment`))
        this._configureEnvironment();
    }));
  }

  /**
   * Destroy engine.
   */
  dispose () {
    this._projects.forEach(project => {project.dispose()});
    this._projects.clear();
    this._providers.clear();
    this._parser.dispose();
  }

  /**
   * Register list of project content providers.
   *
   * Only these content providers can be used to show some information about
   * analyzed project.
   */
  register(...args: [string, ProjectContentProvider][]) {
    for (let arg of args)
      this._providers[arg[0]] = arg[1];
  }

  /**
   * Return true if analysis of a specified project has been already activated.
   */
  isActive(uri: vscode.Uri): boolean {
    return this._projects.has(ProjectEngine._projectID(uri));
  }

  /**
   * Return project with a specified URI.
   */
  project(uri: vscode.Uri): Project|undefined {
    return this._projects.get(ProjectEngine._projectID(uri));
  }

  /**
   * Start processing of a specified project.
   *
   * TODO (kaniandr@gmail.com): currently each project consists of a single
   * file, update to support projects configured with a help of *.json file.
   */
   start(doc: vscode.TextDocument, tool:ToolT): Thenable<Project> {
    return new Promise((resolve, reject) =>  {
      // //не забыть поменять на правильный выбор директории
      // let projectPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tsar_project_file.json');

      // if (!fs.existsSync(projectPath)) {
      //   await vscode.commands.executeCommand('tsar.refactorTsarProject')
      // }
      // const data = await fs.promises.readFile(projectPath, 'utf-8');
      // const fileList = JSON.parse(data);
      // const fileListStrFormat = fileList.toString().replace(',', ' ')
      // // let fileList = json.map(filepath => filepath.join(" "));

      // let command = "tsar -emit-llvm -build-path=" + vscode.workspace.workspaceFolders[0].uri.fsPath + " " + fileListStrFormat;

      // // how send message, if class Project(who send messages) has constructor which need uri of a project, but tota.ll file is not created yet?
      // // let message = new msg.CommandLine(command);
      // // project.send(message);

      // child_process.execSync(command);

      // const compiledFiles = await fileListStrFormat.replace(/\.(c|cpp)\b/g, '.ll');
      // const totalFilePath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'total.ll');

      // try {
      //   child_process.execSync("llvm-link-15 -S " + compiledFiles + " -o " + totalFilePath);
      // } catch (error) {
      //   const errorMessage = `Linking failed: ${error.stderr.toString()}`;
      //   vscode.window.showErrorMessage(errorMessage);
      // }

      // let projectFileUri = vscode.Uri.file(totalFilePath);
      // doc = await vscode.workspace.openTextDocument(projectFileUri);

      let project = this.project(doc.uri);
      if (project !== undefined) {
        vscode.window.showWarningMessage(
          `${log.Extension.displayName} | ${project.prjname}: ${log.Error.alreadyActive}`,
           'Close session', 'Go to Project')
        .then(item => {
          if (item === 'Close session')
            vscode.commands.executeCommand('tsar.stop', project.uri);
          else if (item == 'Go to Project')
            vscode.commands.executeCommand('tsar.open-project', project.uri);
        });
        let state = project.providerState(ProjectProvider.scheme);
        state.provider.update(project);
        return undefined;
      }
       let check = this._checkDocument(doc);
      // if (check)
      //   return reject(check);
      let uri = doc.uri;
      let prjDir = this._makeProjectDir(path.dirname(uri.fsPath));
      if (typeof prjDir != 'string')
        return reject(prjDir);
      this._startServer(uri, <string>prjDir, tool, this._environment, resolve, reject, doc);
      return undefined;
    })
  }

  /**
   * Stop processing of a specified project.
   */
  stop(target: vscode.TextDocument | Project | vscode.Uri) {
    if (ProjectEngine._isUri(target))
      this._stop(target)
    else
      this._stop(target.uri);
  }

  /**
   * Send response to run analysis or perform transformation.
   */
  async runTool(project: Project, query?: string) {
    let cl = new msg.CommandLine(log.Extension.displayName);
    cl.Args[1] = project.uri.fsPath;
    let tool:any = project.tool;
    if (tool.options) {
      let user_options = await vscode.window.showQuickPick(
        tool.options as any[],
        {
          canPickMany: true,
          ignoreFocusOut: true,
          placeHolder: log.Message.selectOptions
        });
      if (user_options)
        for (let option of user_options) {
          if (option.selectFile) {
            let selectedFile = await vscode.window.showOpenDialog(
              Object.assign({ canSelectMany: false }, option.selectFile));
            if (selectedFile && selectedFile.length > 0)
              cl.Args.push(`${option.target}${selectedFile[0].fsPath}`);
          } else if (option.manualInput) {
            let manualInput = await vscode.window.showInputBox({
              ignoreFocusOut: true,
              placeHolder: option.description,
            });
            if (manualInput)
              for (let manualOption of manualInput.split(/\s/))
                cl.Args.push(manualOption.trim());
          } else if (option.options) {
            let nested_options = await vscode.window.showQuickPick(
              option.options as any[],
              {
                canPickMany: option.canPickMany as boolean,
                ignoreFocusOut: true,
                placeHolder: log.Message.selectOptions
              });
            if (nested_options) {
              let value = option.target;
              if (option.canPickMany)
                for (let nest of nested_options)
                  value += nest.target;
              else
                value += nested_options.target;
              cl.Args.push(value);
            }
          } else {
            cl.Args.push(option.target);
          }
        }
    }
    project.arguments = cl.Args;
    if (query)
      cl.Query = query;
    cl.Output = path.join(project.dirname, log.Project.output);
    cl.Error = path.join(project.dirname, log.Project.error);
    project.send(cl);
    return project;
  }

  // project should be *.json file
  async runProjectTool(project: Project, query?: string) {
    let cl = new msg.CommandLine(log.Extension.displayName);

    this._projects.forEach((val, key) =>{
      cl.Args.push(vscode.Uri.file(key).fsPath);
    })
    cl.Args.push("-emit-llvm");
    cl.Query = "-emit-llvm";
    // cl.Args.push(query);

    project.arguments = cl.Args;

    // if (query)
    //   cl.Query = query;
    cl.Output = path.join(project.dirname, log.Project.output);
    cl.Error = path.join(project.dirname, log.Project.error);

    await project.send(cl);

    return project;
  }

  /**
   * Stop analysis of a specified project.
   */
  private _stop(uri: vscode.Uri) {
    let project = this.project(uri);
    if (project === undefined)
      return;
    let id = ProjectEngine._projectID(project.uri);
    this._projects.delete(id);
    project.dispose();
    log.Log.logs[0].write(
      log.Message.close.replace('{0}', project.uri.toString()));
  }

  /**
  *  Check that a specified document can be analyzed.
  */
  private _checkDocument(doc: vscode.TextDocument): Error[]|undefined {
    let uri = doc.uri;
    /// TODO (kaniandr@gmail.com): suggest save it and open appropriate dialog.
    let errors: Error[] = [];
    if (doc.isUntitled)
      errors.push(
        new Error(log.Error.untitled.replace('{0}', uri.fsPath)));
    if (!log.Extension.langauges[doc.languageId])
      errors.push(
        new Error(log.Error.language.replace('{0}', uri.fsPath)));
    return (errors.length > 0) ? errors : undefined;
  }

  /**
   *  Create directory for a project-specific files, returns full path of
   *  created directory on success, otherwise returns appropriate diagnostics.
   */
  private _makeProjectDir(pathToPrj: string): Error|string {
    let prjDir = path.join(pathToPrj, log.Project.directory);
    try {
      if (fs.existsSync(prjDir)) {
        let stat = fs.statSync(prjDir);
        if (!stat.isDirectory())
          return new Error(log.Error.notDirectory.replace('{0}', prjDir));
      } else {
        fs.mkdirSync(prjDir);
      }
    }
    catch (err) {
      return new Error(err.message);
    }
    return prjDir;
  }
  /**
   * Start server to analyze project and initialize connection between the
   * server and adviser, returns true on success.
   *
   * If some errors occur during initialization they will be treated
   * and evaluated as internal errors.
   * Function _onResponse() will be set as listener for responses from server.
   *
   * @param env This parameter is used to specified environment of server
   *  execution.
   */
  private _startServer(uri: vscode.Uri, prjDir: string,
      tool: ToolT, env: any, resolve: any, reject: any, doc) {
    let server: child_process.ChildProcess;
    let userConfig = vscode.workspace.getConfiguration(log.Extension.id);
    let pathToServer = which.sync(
      userConfig.get('advanced.analysisServer'), { nothrow: true });
    if (!pathToServer) {
      reject(new Error(log.Error.serverNotFound.replace('{0}', 'tsar-server')));
      return;
    }
    // TSAR Server uses signal processing to flush session log on termination.
    // However, kill() on Windows does not emulate signals, it terminates
    // application in unknown way instead. So, we always disable session logging
    // on Windows OS.
    let args = userConfig.get('advanced.log.enabled') !== true ||
               process.platform.match(/^win/i) ? [] :
      [ path.join(prjDir, log.Project.session.replace('{0}', `${Date.now()}`)) ];
    log.Log.logs[0].write(log.Message.serverFound.replace('{0}', pathToServer));
    server = child_process.spawn(pathToServer, args,
      { env: env, cwd: path.dirname(uri.fsPath), windowsHide: true });
    server.on('error', (err) => {this._internalError(err)});
    server.on('close', () => {this._stop(uri);});
    server.on('exit', (code, signal) => {
      log.Log.logs[0].write(log.Message.stopServer.replace('{0}', signal))});
    // do not move project inside 'data/message' event listener
    // it must be shared between all messages evaluation
    let project: Project;
    let onServerData = async (raw: string) => {
      let client: net.Socket;
      try {
        let data = JSON.parse(raw);
        if (data['Status'] === log.Server.start) {
          if (!('TSARVersion' in data))
            throw new Error(log.Error.serverVersion);
          log.Log.logs[0].write(
            log.Message.serverVersion.replace('{0}', data['TSARVersion']));
        } else if (data['Status'] === log.Server.listening) {
          log.Log.logs[0].write(log.Message.listening);
          let addr: any = {
            port: data['ServerPort'],
            host: data['ServerAddress'],
          };
          client = net.connect(addr, () => {client.setEncoding('utf8')});
          project = new Project(uri, prjDir, tool, client, server);
          this._context.subscriptions.push(project);
          for (let scheme in this._providers) {
            let provider= this._providers[scheme];
            provider.onDidAriseInternalError(this._internalError,
              this, this._context.subscriptions);
            project.register(scheme, provider.state());
          }
          if (path.extname(uri.fsPath).toLowerCase() === '.json') {
            const data = fs.readFileSync(uri.fsPath, 'utf-8');
            const fileList = JSON.parse(data);
            for (const file of fileList) {
              this._projects.set(ProjectEngine._projectID(vscode.Uri.file(file)), project);
            }
              
          
          } else {
            this._projects.set(ProjectEngine._projectID(uri), project);
          }
          client.on('error', (err) => {this._internalError(err)});
          client.on('data', (data:string) => {
            log.Log.logs[0].write(log.Message.server.replace('{0}', data));
          });
          client.on('data', this._onResponse.bind(this, project, client));
        } else if (data['Status'] === log.Server.connection) {
          log.Log.logs[0].write(log.Message.connection
            .replace('{0}', `${data['ClientAddress']}:${data['ClientPort']}`)
            .replace('{1}', `${data['ServerAddress']}:${data['ServerPort']}`));
          log.Log.logs[0].write(
            log.Message.active.replace('{0}', project.uri.toString()));
          resolve(project);
        } else if (data['Status'] === log.Server.error) {
          if (data['Message'])
            throw new Error(data['Message']);
          else
            throw new Error(log.Error.internal);
        } else if (data['Status'] === log.Server.close ||
                   data['Status'] === log.Server.send ||
                   data['Status'] === log.Server.receive) {
          log.Log.logs[0].write(log.Message.serverState
            .replace('{0}', data['Status'])
            .replace('{1}', data['Message']));
        } else {
          throw new Error(log.Error.internal);
        }
      }
      catch(err) {
        reject(err);
        if (server)
          server.kill();
        if (client)
          client.destroy();
      }
    };
    createInterface({
      input     : server.stdout,
      terminal  : false,
    })
    .on('line', onServerData)
    .on('close', () => {
      // If server redirect stdout, this readline interface will be cloesd.
      // Usually TSAR shared library redirects IO to files specified by the client.
      // In this case all output messages will be stored in a corresponding file.
      log.Log.logs[0].write(log.Message.serverIORedirected);
    });
  }

  /**
   * Evaluate response received from the server.
   */
  private _onResponse(project: Project, client: net.Socket, response: string) {
    try {
      let array = response.split(log.Project.delimiter);
      if (array[array.length - 1] == '')
        array.pop(); // ignore the last empty substring
      if (array.length == 0)
        return;
      if (response.substr(response.length - log.Project.delimiter.length) != log.Project.delimiter) {
        if (array.length == 1) {
          project.spliceRawResponse(array[0]);
          return;
        }
        array[0] = project.extractRawResponse() + array[0];
        project.spliceRawResponse(array.pop());
      } else {
        array[0] = project.extractRawResponse() + array[0];
      }
      for (let data of array) {
        if (data === 'REJECT')
          throw new Error(log.Error.rejected);
        let obj = this._parser.fromJSON(data);
        if (!obj)
          throw new Error(log.Error.unknownResponse.replace('{0}', data));
        project.update(obj);
        if (obj instanceof msg.Diagnostic) {
          // Do not invoke client.end() here because it prevents showing errors
          // in output channel project.output.
          switch(obj.Status) {
            case msg.Status.Error:
            case msg.Status.Invalid:
              this._diagnostic(project, obj);
              break;
          }
          return;
        }
      }
    }
    catch(err) {
      this._internalError(err);
      client.destroy();
    }
  }

  /**
   * This function evaluates internal errors, which is not clear for user and
   * should be evaluated by extension developer team.
   *
   * TODO (kaniadnr@gmail.com): store internal errors in a special
   * extension log and crash.report file, propose the user to send report
   * to the DVM team (add appropriate button in error message box).
   */
  private _internalError(err: Error): void {
    log.Log.logs[0].write(`${log.Error.internal}: ${err.message}`);
    vscode.window.showErrorMessage(
      `${log.Extension.displayName}: ${log.Error.internal}`);
  }

  /**
   * Show diagnostics to a user.
   */
  private _diagnostic(project: Project, diag: msg.Diagnostic) {
    switch (diag.Status) {
      case msg.Status.Error:
      case msg.Status.Invalid:
        vscode.window.showErrorMessage(
          `${log.Extension.displayName} | ${project.prjname}: ${log.Error.general}`);
        break;
      case msg.Status.Success:
        vscode.window.showInformationMessage(
          `${log.Extension.displayName} | ${project.prjname}: ${log.Message.active.replace('{0}', project.prjname)}`);
        break;
    }
    for (let err in diag.Error)
      vscode.window.showErrorMessage(
        `${log.Extension.displayName} | ${project.prjname}: ${diag.Error[err]}`);
    if (diag.Terminal) {
      project.output.appendLine(diag.Terminal);
      project.output.show(true);
    }
  }
}

/**
 * This content provider allows to add readonly documents
 * which represent project traits to the editor.
 */
export interface ProjectContentProvider {
  /**
   * Fired when an internal error occured.
   */
  readonly onDidAriseInternalError : vscode.Event<Error>;

  /**
   * Returns new description of a project content provider state.
   */
  state(): ProjectContentProviderState;

  /**
   * Update visible content for a specified project.
   */
  update(project: Project): any;

  /**
   * Clear visible content for a specified project.
   */
  clear(project: Project): any;

  /**
   *  Dispose provider.
   */
  dispose(): any;
}

/**
 * This describes state of a project content provider.
 */
export interface ProjectContentProviderState {
  /**
   * Content provider with a current state.
   */
  readonly provider: ProjectContentProvider;

  /**
   * Fired when a visible content is disposed.
   *
   * It should not dispose the whole state.
   * Implementation must allow to safely use state after it.
   */
  readonly onDidDisposeContent: vscode.Event<void>;

  /**
   * True if actual content is available, otherwise some data
   * should be loaded from server.
   *
   * @param request Data which would be requested if necessary.
   */
  actual(request: any): boolean;

  /**
   * Access 'active' property of the state.
   *
   * Return `true` if state is active.
   *
   * Usage example. If set to `true` fire event `onDidChangeActiveState` event
   * and notify listeners that the state wait for content to show. Project is
   * listening for this event and try to show content on activation.
   */
  active: boolean;

  /**
   * Fired when state 'active' property is changed.
   */
  readonly onDidChangeActiveState : vscode.Event<boolean>;

  /**
   * List of disposable objects which should be disposed with this state.
   */
  readonly disposables: vscode.Disposable [];

  /**
   * Dispose of the state.
   *
   * Do not dispose providers when state is disposed.
   */
  dispose(): any;
}

/**
 * This represents one of evaluated projects.
 *
 * Each project has a unique identifier (uri). Only one project with the same
 * uri can be analyzed at a time.
 *
 * Project is a disposable object and can be stored in vscode.Disposable.
 */
export class Project {
  private _prjUri: vscode.Uri;
  private _prjDir: string;
  private _client: net.Socket;
  private _server: child_process.ChildProcess;
  private _rawResponse = '';
  private _responses = [];
  private _newResponse = 0;
  private _providers = new Map<string, ProjectContentProviderState>();
  private _output: vscode.OutputChannel
  private _disposable: vscode.Disposable;
  private _isDisposed = false;
  private _tool: ToolT;

  public arguments: msg.Arguments;

  public focus: ProjectContentProviderState;

  /**
   * Create a project with a specified uri.
   *
   * @param projectUri Unique identifier of a project.
   * @param projectDir Basename of a directory which will contain project
   * internal data (logs and etc.), for example .tsar.
   * @param client Socket to interconnect with TSAR analyzer.
   * @param server A standalone process where TSAR analyzer is running.
   */
  constructor(projectUri: vscode.Uri, projectDir: string, tool: {},
      client: net.Socket, server: child_process.ChildProcess) {
    this._prjUri = projectUri;
    this._prjDir = projectDir;
    this._client = client;
    this._server = server;
    this._output = vscode.window.createOutputChannel(
      log.Terminal.displayName.replace('{0}', this.prjname));
    this._disposable = vscode.Disposable.from(this._output);
    this._tool = tool;
  }

  /**
   * Return tool configuration which is used to analyze this project.
   */
  get tool(): ToolT { return this._tool; }

  /**
   * Dispose project and its data (sockets, processes, windows).
   */
  dispose() {
    if (this._isDisposed)
      return;
    this._providers.forEach(state => {state.provider.clear(this)});
    this._isDisposed = true;
    this._providers.clear();
    this._output.hide();
    this._client.destroy();
    this._server.kill();
    this._disposable.dispose();
  }

  /**
   * Send request to a server.
   */
  send(request: any): Promise<void> {
    return new Promise((resolve, reject) => {
    let requestString = JSON.stringify(request) + log.Project.delimiter;
    log.Log.logs[0].write(log.Message.client.replace('{0}', requestString));
    this._client.write(requestString)

    this._client.on('data', (data) => { 
      resolve();
    });
    this._client.on('error', (error) => {
      reject(error);
    });

    this._client.on('end', () => {
      reject();
    });

    // this._client.on('data', (data) => {
    //   const response = data.toString();
    //   console.log('Ответ от сервера:', response);
    // });

    // this._client.on('end', () => {
    //   console.log('Соединение с сервером закрыто.');
    // });
    /*if (!this._client.write(requestString))
      this._client.once('drain', () => {this.send(request)});*/
  })}

  /**
   * Register content provider with a specified base scheme.
   */
  register(scheme: string, state: ProjectContentProviderState) {
    this._providers.set(scheme, state);
    this._disposable = vscode.Disposable.from(this._disposable, state);
    state.onDidChangeActiveState((isActive: boolean) => {
      if (isActive)
        state.provider.update(this);
    });
  }

  /**
   * Return state of content provider with a specified scheme.
   *
   * The provider with a specified scheme must be at first registered in a
   * project with register() method.
   */
  providerState(scheme: string) : ProjectContentProviderState|undefined {
    return this._providers.get(scheme);
  }

  /**
   * Update provider with a specified scheme.
   *
   * The specified response will be stored in a queue of response and can be
   * accessed via response() getter from provider.
   * After execution of ProjectProvider::update() method the response will
   * be popped out. Consider this in case of asyncronous update() method.
   */
  updateProvider(scheme: string, response: any) {
    this._responses.push(response);
    let state = this.providerState(scheme);
    if (state)
      state.provider.update(this);
    this._pop();
  }

  /**
   * Update all registered providers.
   *
   * The specified response will be stored in a queue of response and can be
   * accessed via response() getter from provider.
   * After execution of ProjectProvider::update() methods for each provider
   * the response will be popped out. Consider this in case of asyncronous
   * update() method.
   */
  update(response: any) {
    this._responses.push(response);
    this._providers.forEach(state => {state.provider.update(this)});
    this._pop();
  }

  /**
   * Write chunk to the end of a raw response buffer.
   *
   * If a size of response exceeds the size of internal buffer
   * which is used to exchange data between client and server,
   * the entire response is split into chunks. Then the client
   * subsequently receives this chunks. It may use this method
   * to merge these chunks and to store the result in a buffer.
   */
  spliceRawResponse(chunk: string) {
    this._rawResponse += chunk;
  }

  /**
   * Clear the raw response buffer and return its value.
   */
  extractRawResponse() : string {
    let tmp = this._rawResponse;
    this._rawResponse = '';
    return tmp;
  }

  /**
   * Return number of all responses some of which have been already evaluated
   * and other are new responses.
   */
  responseNumber(): number { return this._responses.length; }

  /**
   * Return project unique identifier.
   */
  get uri(): vscode.Uri { return this._prjUri; }

  /**
   * Return project internal directory name.
   */
  get dirname(): string { return this._prjDir; }

  /**
   * Return project name.
   */
  get prjname(): string { return path.basename(this._prjUri.fsPath); }

  /**
   * Return the first response which has not been evaluated yet, to mark that
   * it is evaluated use pop() function.
   */
  get response(): any|undefined {
    return (this._newResponse < this._responses.length) ?
      this._responses[this._newResponse] : undefined;
  }

  /**
   * Return output channel to represent terminal output.
   */
  get output(): vscode.OutputChannel {return this._output;}

  /**
   * Extract the first response which has not been evaluated yet from a response
   * queue.
   */
  private _pop(): any|undefined  {
    if (this._newResponse < this._responses.length)
      return this._responses[this._newResponse++];
  }
}
