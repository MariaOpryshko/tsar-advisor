//===--- extension.ts ----- TSAR Advisor Extension ---------- TypeScript --===//
//
//                           TSAR Advisor (SAPFOR)
//
// This is a start point of the extension.
//
//===----------------------------------------------------------------------===//

'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as log from './log';
import * as lt from './loopTree';
import * as at from './aliasTree';
import * as msg from './messages';
import {onReject} from './functions';
import {ProjectEngine, Project} from './project';
import {ProjectProvider} from './general';
import {CalleeFuncProvider, CalleeFuncProviderState} from './calleeFunc';
import * as t from './transformProvider';
import server from './tools';
import { FileListProvider } from './fileList';
import { LoopTreeViewProvider } from './loopExplorer';
import simpleGit, { SimpleGit } from 'simple-git'
import {exec, execSync} from 'child_process'


/**
 * Open log file (log.Extension.log), returns true on success.
 */
function openLog(): boolean {
  try {
    let newDir = false;
    let dir = path.dirname(log.Extension.log);
    if (fs.existsSync(dir)) {
      let stat = fs.statSync(dir);
      if (!stat.isDirectory())
        throw new Error(log.Error.notDirectory.replace('{0}', dir));
    }
    else {
      fs.mkdirSync(dir);
      newDir = true;
    }
    let userConfig = vscode.workspace.getConfiguration(log.Extension.id);
    let logOn = userConfig.has('advanced.log.enabled') &&
                userConfig.get('advanced.log.enabled') === true
    log.Log.logs.push(new log.Log(log.Extension.log, logOn));
    if (newDir)
      log.Log.logs[0].write(log.Message.createLog);
  }
  catch(err) {
    vscode.window.showErrorMessage(
      `${log.Extension.displayName}: ${log.Error.internal}: ${log.Error.openLog}`);
    return false;
  }
  return true;
}

/*
Matches commit hashes to the column number
Return value: [{ hash: string,
          children: string[],
          height: number}]
*/
async function getCommitGraph(repositoryPath: string) {
  let commits = await getCommitsChildren(repositoryPath);

  const orderedCommits = getSortedCommits(repositoryPath);
  const hashIdx: Map<string, number> = new Map();
  
  orderedCommits.forEach((value, index) => {
    hashIdx.set(value.hash, index);
  });
  
  const height: number[] = Array(Object.keys(orderedCommits).length).fill(0);
  const subTree: string[] = [];

  function dfs(commit_hash: string) {
    if(commits[commit_hash].length == 0 || height[hashIdx.get(commit_hash)] != 0){
        subTree.push(commit_hash);
        let newHeight = 0;
        for(let idx = hashIdx.get(subTree[0]); idx <= hashIdx.get(subTree[subTree.length - 1]); idx++){
          if(height[idx] > newHeight){
            newHeight = height[idx];
          }
        }

        for(let idx = 1; idx <= subTree.length - 2; idx++){
          height[hashIdx.get(subTree[idx])] = newHeight +1;
        }
        
        if(commits[commit_hash].length == 0 && height[hashIdx.get(commit_hash)] == 0){
          height[hashIdx.get(commit_hash)] = newHeight + 1;
        }

        subTree.length = 0;

        return;
      }

      for (const neighbor of commits[commit_hash]) {
        subTree.push(commit_hash);  
        dfs(neighbor);
      }
  }

  dfs(orderedCommits[0].hash);
  height[0] = 1;

  let answer = [];
  for(const commit of orderedCommits){
    answer.push({
      hash: commit.hash,
      children: commits[commit.hash],
      height: height[hashIdx.get(commit.hash)]
    });
  }
  return answer;
}


function getSortedCommits(repositoryPath: string): { hash: string; date: number}[] {
  const gitLogOutput = execSync('git log --pretty=format:"%H %at" --all', { cwd: repositoryPath }).toString();
  
  const lines = gitLogOutput.split('\n');

  const commits = lines.map(line => {
      const [hash, dateString] = line.split(' ');
      return {
          hash,
          date: parseInt(dateString)
      };
  });

  commits.sort((a, b) => a.date - b.date);

  return commits;
}

async function getCommitsChildren(repositoryPath: string): Promise<{ [key: string]: string[] } | null> {
  return new Promise((resolve, reject) => {
      exec('git rev-list --all --children', { cwd: repositoryPath }, (error, stdout, stderr) => {
          if (error) {
              console.error('Error executing git log:', stderr);
              reject(null);
              return;
          }

          const commitGraph: { [key: string]: string[] } = {};
          const lines = stdout.trim().split('\n');

          lines.forEach(line => {
              const [commitHash, ...parentHashes] = line.split(' ');
              commitGraph[commitHash] = parentHashes;
          });

          resolve(commitGraph);
      });
  });
}


function getHEADCommit(repositoryPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: repositoryPath }).toString().trim();
}


function getCommitsData(repositoryPath: string): {
  hash: string,
  authorName: string,
  authorEmail: string,
  authorDate: string,
  message: string}[] {
  const gitLogOutput = execSync('git log --format="%H%n%an%n%ae%n%ai%n%s" --all', { cwd: repositoryPath }).toString();

  const lines = gitLogOutput.split('\n');
  let commits = [];

  for (let i = 0; i < lines.length - 1; i += 5) {
    commits.push({
                    hash: lines[i],
                    authorName: lines[i + 1],
                    authorEmail: lines[i + 2],
                    authorDate: lines[i + 3].slice(0, -6),
                    message: lines[i + 4]
    });
  }

  return commits;
}

function getGraphWebviewContent(commitGraph, HEAD, commitsData) {
  const commitGraphString = JSON.stringify(commitGraph);
  const commitsDateString = JSON.stringify(commitsData);

  const x = 210; // Initial x position of git graph
  const y = 50; // Initial y position of git graph
  const xOffset = 100; // Horizontal distance between nodes
  const yOffset = 100; // Vertical distance between nodes
  const textWidth = 500; // Width of column with commit message 

  let max_height = 1; // Width of graph 

  commitGraph.forEach((commit)=> {
    if (commit.height > max_height) {
      max_height = commit.height;
    }
  });
  
  return `<!doctype html>
  <html lang="en">
  <head>
    <title>Git Graph</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
      body {
        background-color: #f8f9fa;
        font-family: Arial, sans-serif;
      }
      circle {
        transition: fill 0.3s;
      }
      circle:hover {
        fill: gold;
        cursor: pointer;
      }
      .textGroup text {
        font: 19px sans-serif;
        pointer-events: all;
        fill: #cc6d2e;
        font-weight: bolder;
        transition: fill 0.3s;
      }
      .textGroup text:hover {
        font: 20px sans-serif;
        pointer-events: all;
        fill: gold;
        cursor: pointer;
        font-weight: bolder;
      }
      .headGroup text {
        font: 19px sans-serif;
        pointer-events: all;
        fill: lightseagreen;
        font-weight: bolder;
      }
      .dateGroup text {
        font: 18px sans-serif;
        fill: dimgray;
      }
      .container {
          margin: 0;
          padding: 0;
          display: flex;
          height: 100vh;
      }
      svg {
          width: 100%;
          height: auto;
          display: block;
      }
      .left {
          width: 70%;
          overflow-y: auto;
      }
      .right {
          width: 30%;
          padding: 20px;
          background-color: #f0f0f0;
          box-sizing: border-box;
          position: fixed;
          right: 0;
          height: 100%;
          color: black;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="left">
        <svg id="graph"></svg>
      </div>
      <div id="commitDetails" class="right">
        <h2>Commit Details</h2>
        <p><strong>Hash:</strong> <span id="commitHash"></span></p>
        <p><strong>Message:</strong> <span id="commitMessage"></span></p>
        <p><strong>Author Name:</strong> <span id="authorName"></span></p>
        <p><strong>Author Email:</strong> <span id="authorEmail"></span></p>
        <p><strong>Date:</strong> <span id="authorDate"></span></p>    
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();

      let commitGraphString = ${commitGraphString};
      commitGraphString = commitGraphString.reverse();
      const commitsDateString = ${commitsDateString};

      let max_height = ${max_height};
      const x = ${x};
      const y = ${y};
      const xOffset = ${xOffset};
      const yOffset = ${yOffset};
      const textWidth = ${textWidth};
      let HEAD = "${HEAD}";

      const branchColors = ["navy", "firebrick", "darkgreen", "darkviolet", "darkgoldenrod", "teal", "#abdda4", "#66c2a5", "#c637e8", "#5e4fa2qqq"]

      const nodes = [];
      const links = [];

      commitGraphString.forEach(commit => {
        nodes.push({id: commit.hash});
        commit.children.forEach(child => {
          links.push({ source: commit.hash, target: child });
        });
      });

      const positions = {};
      
      // Assign positions to nodes
      commitGraphString.forEach((commit, index)=> {
        positions[commit.hash] = { x: x + (commit.height - 1) * xOffset, y: y + (index * yOffset)};
      });

      
      const width = max_height * xOffset + x + textWidth;
      const height = commitGraphString.length * yOffset + y;

      // SVG setup
      const svg = d3.select("svg")
        .attr("width", "40%")
        .attr("height", "100%")
        .attr("viewBox", [0, 0, width, height])
        .attr("preserveAspectRatio", "xMidYMid meet");
        

      // Lines setup
      svg.append("g")
        .attr("stroke-opacity", 0.9)
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke", d => {
          let max_x = positions[d.source].x > positions[d.target].x ? positions[d.source].x : positions[d.target].x;
          let color_idx = (max_x - x) / xOffset % 10;
          return branchColors[color_idx];
        })
        .attr("stroke-width", 5)
        .attr("x1", d => positions[d.source].x)
        .attr("y1", d => positions[d.source].y)
        .attr("x2", d => positions[d.target].x)
        .attr("y2", d => positions[d.target].y);


      // Nodes setup
      svg.append("g")
        .selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("stroke-width", 4)
        .attr("stroke", d => branchColors[(positions[d.id].x - x) / xOffset % 10])
        .attr("fill", d => d.id === HEAD ? "white" : branchColors[(positions[d.id].x - x) / xOffset % 10])
        .attr("r", 7)
        .attr("class", d => {
          let classes = [];
          if (d.id === HEAD) {
            classes.push("HEADElem");
          } else {
            classes.push("usualElem");
          }
          classes.push(d.id);
          classes.push("circle");
          return classes.join(" ");
        })
        .attr("cx", d => positions[d.id].x)
        .attr("cy", d => positions[d.id].y)
        .on("dblclick", function(event, d) {
          const commitHash = d.id;
          vscode.postMessage({ command: 'gitCheckout', commitHash: commitHash });
        })
        .on("click", function(event, d) {
          const commitDate = commitsDateString.find(commit => commit.hash === d.id);
          showCommitDetails(commitDate);
        });

      
      // Column with commit messages
      const textGroup = svg.append("g")
        .attr("class", "textGroup");
      
      // Commit messages setup
      textGroup.selectAll("text")
        .data(nodes)
        .join("text")
        .attr("x", d => d.id === HEAD ? max_height * xOffset + x + 70 : max_height * xOffset + x - 10)
        .attr("y", d => positions[d.id].y)
        .attr("dy", "0.35em")
        .attr("class", d => {
          let classes = [];
          if (d.id === HEAD) {
            classes.push("HEADElem");
          } else {
            classes.push("usualElem");
          }
          classes.push(d.id); 
          classes.push("commitHash");
          return classes.join(" ");
        })
        .text(d => commitsDateString.find(commit => commit.hash === d.id).message)
        .on("dblclick", function(event, d) {
          const commitHash = d.id;
          vscode.postMessage({ command: 'gitCheckout', commitHash: commitHash });
        })
        .on("click", function(event, d) {
          const commitDate = commitsDateString.find(commit => commit.hash === d.id);
          showCommitDetails(commitDate);
        });


      // Gpoup whith HEAD tag column
      const headGroup = svg.append("g")
        .attr("class", "headGroup");

      // Border of HEAD tag setup
      headGroup.selectAll("rect")
        .data(nodes)
        .join("rect")
        .attr("class", d => { // each element of headGroup has individual class name for html-page update
          let classes = [d.id];
          if (d.id === HEAD) {
            classes.push("HEADElem");
          } else {
            classes.push("usualElem");
          }
          classes.push("HEADBorder");
          return classes.join(" ");
        })
        .attr("x", d => max_height * xOffset + x - 10)
        .attr("y", d => positions[d.id].y - 15)
        .attr("width", d => d.id === HEAD ? 72 : 0)
        .attr("height", d => d.id === HEAD ? 30 : 0)
        .attr("rx", 5)
        .attr("ry", 5)
        .attr("stroke", "lightseagreen")
        .attr("fill", "none")
        .attr("stroke-width", 2);

      // HEAD tag setup
      headGroup.selectAll("text")
        .data(nodes)
        .join("text")
        .attr("class", d => {
          let classes = [d.id];
          if (d.id === HEAD) {
            classes.push("HEADElem");
          } else {
            classes.push("usualElem");
          }
          classes.push("HEADText");
          return classes.join(" ");
        })
        .attr("x", d => max_height * xOffset + x) // Offset text to the right of nodes
        .attr("y", d => positions[d.id].y)
        .attr("dy", "0.35em")
        .text(d => d.id === HEAD ? "HEAD" : "");


      // Group with dates of commits
      const dateGroup = svg.append("g")
        .attr("class", "dateGroup");
      
      // Dates column setup
      dateGroup.selectAll("text")
        .data(nodes)
        .join("text")
        .attr("x", 0)
        .attr("y", d => positions[d.id].y)
        .attr("dy", "0.35em")
        .text(d => commitsDateString.find(commit => commit.hash === d.id).authorDate);

      // Updating Commit Data
      function showCommitDetails(commit) {
        document.getElementById("commitHash").textContent = commit.hash;
        document.getElementById("authorName").textContent = commit.authorName;
        document.getElementById("authorEmail").textContent = commit.authorEmail;
        document.getElementById("authorDate").textContent = commit.authorDate;
        document.getElementById("commitMessage").textContent = commit.message;
        document.getElementById("commitDetails").style.display = 'block';
      }

      window.addEventListener('message', event => {
        const message = event.data;

        switch (message.command) {
          case 'gitCheckout': // Page update after successful checkout
            
            let oldElemets = Array.from(document.getElementsByClassName("HEADElem"));
            
            for (let i = 0; i < oldElemets.length; i++) {

              if (oldElemets[i].classList.contains("circle")) {
                oldElemets[i].setAttribute("fill", branchColors[(positions[HEAD].x - x) / xOffset % 10]);

              } else if (oldElemets[i].classList.contains("commitHash")) {
                oldElemets[i].setAttribute("x", max_height * xOffset + x - 10);

              } else if (oldElemets[i].classList.contains("HEADBorder")) {
                oldElemets[i].setAttribute("width", 0);
                oldElemets[i].setAttribute("height", 0);

              } else if (oldElemets[i].classList.contains("HEADText")) {
                oldElemets[i].textContent = "";
              }

              oldElemets[i].classList.remove("HEADElem");
              oldElemets[i].classList.add("usualElem");
            }

            HEAD = message.commitHash;

            let newElements = Array.from(document.getElementsByClassName(HEAD));

            for (let i = 0; i < newElements.length; i++) {
              
              if (newElements[i].classList.contains("circle")) {
                newElements[i].setAttribute("fill", "white");

              } else if (newElements[i].classList.contains("commitHash")) {
                newElements[i].setAttribute("x", max_height * xOffset + x + 70);

              } else if (newElements[i].classList.contains("HEADBorder")) {
                newElements[i].setAttribute("width", 72);
                newElements[i].setAttribute("height", 30);

              } else if (newElements[i].classList.contains("HEADText")) {
                newElements[i].textContent = "HEAD";
              }

              newElements[i].classList.add("HEADElem");
              newElements[i].classList.remove("usualElem");
            }

            break;
        }
      });
    </script>
  </body>
  </html>`;
}



export function activate(context: vscode.ExtensionContext) {
  if (!openLog())
    return;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(`${log.Extension.id}.advanced.log.enabled`)) {
      let userConfig = vscode.workspace.getConfiguration(log.Extension.id);
      log.Log.logs[0].enabled = userConfig.has('advanced.log.enabled') &&
                                userConfig.get('advanced.log.enabled') === true;
    }
  }));
  log.Log.logs[0].write(log.Message.extension);
  let engine = new ProjectEngine(context);
  engine.register(
    [FileListProvider.scheme, new FileListProvider],
    [ProjectProvider.scheme, new ProjectProvider],
    [CalleeFuncProvider.scheme, new CalleeFuncProvider],
    [lt.LoopTreeProvider.scheme, new lt.LoopTreeProvider],
    [LoopTreeViewProvider.scheme, new LoopTreeViewProvider],
    [t.TransformationProvider.scheme, new t.TransformationProvider],
    [at.AliasTreeProvider.scheme, new at.AliasTreeProvider]
  );

  let gitGraph = vscode.commands.registerCommand('tsar.gitgraph', async (uri: vscode.Uri) => {
    const repositoryPath = path.dirname(uri.fsPath);
    
    const GitFilePath = path.join(path.dirname(uri.fsPath), '.tsar_git');
    if (!fs.existsSync(GitFilePath)) {
      fs.writeFileSync(GitFilePath, '', 'utf-8'); // here can be written information that should be saved for git
    }

    let git = simpleGit(repositoryPath);
    git.checkIsRepo()
    .then(async (isRepo) => {

      if (!isRepo) {
        await git.init();

      } else {
        const panel = vscode.window.createWebviewPanel(
          'commitGraph',
          'Commit Graph',
          vscode.ViewColumn.One,
          {
            enableScripts: true
          }
        );

        const graph = await getCommitGraph(repositoryPath);
        const HEADCommit = getHEADCommit(repositoryPath);
        const commitsData = getCommitsData(repositoryPath);
        
        panel.webview.html = getGraphWebviewContent(graph, HEADCommit, commitsData);

        panel.webview.onDidReceiveMessage(
          async message => {
            switch (message.command) {
              case 'gitCheckout': 
                try {
                  await git.checkout(message.commitHash);
                  panel.webview.postMessage({ command: 'gitCheckout', commitHash: message.commitHash })
                } catch(err){
                  vscode.window.showErrorMessage(err.message, "Close");
                }
                break;
            }
          },
          undefined,
          context.subscriptions
        );
      }
    })
  });

  let start = vscode.commands.registerCommand(
    'tsar.start', (uri:vscode.Uri) => {
      vscode.workspace.openTextDocument(uri)
        .then((success) => {
          return engine.start(success,
            server.tools.find(t=>{return t.name === 'tsar'}));
         })
        .then(
          async project => {
            await engine.runTool(project);
            project.providerState(FileListProvider.scheme).active = true;
            project.send(new msg.FileList);
            vscode.commands.executeCommand('tsar.function.list', project.uri);
            
            let git = simpleGit(path.dirname(project.uri.fsPath));
            git.checkIsRepo()
            .then(async (isRepo) => {
              if (!isRepo) {
                await git.init();
              }
            })

            let GitFilePath = path.join(path.dirname(project.uri.fsPath), '.tsar_git');
            if (!fs.existsSync(GitFilePath)) {
              fs.writeFileSync(GitFilePath, '', 'utf-8'); // here can be written information that should be saved for git
            }
          },
          reason => { onReject(reason, uri) })
    });
  t.registerCommands([
    {
      command: 'tsar.transform.propagate',
      title: 'Expression Propagation',
      run: '-clang-propagate'
    },
    {
      command: 'tsar.transform.inline',
      title: 'TSAR Function Inlining',
      run: '-clang-inline'
    },
    {
      command: 'tsar.transform.replace',
      title: 'TSAR Structure Replacement',
      run: '-clang-struct-replacement'
    },
    {
      command: 'tsar.transform.rename',
      title: 'TSAR Local Renaming',
      run: '-clang-rename'
    },
    {
      command: 'tsar.transform.dedecls',
      title: 'TSAR Dead Declarations Elimination',
      run: '-clang-de-decls'
    },
    {
      command: 'tsar.parallel.openmp',
      title: 'TSAR Parallelization with OpenMP',
      run: '-clang-openmp-parallel'
    },
/*    {
      command: 'tsar.parallel.dvmh',
      title: 'TSAR Parallelization with DVMH',
      run: '-clang-experimental-apc-dvmh'
    },
*/
    {
      command: 'tsar.parallel.dvmhsm',
      title: 'TSAR Shared Memory Parallelization with DVMH',
      run: '-clang-dvmh-sm-parallel'
    },
    {
      command: 'tsar.analysis.check',
      title: 'TSAR Check User-defined Properties',
      run: '-check'
    }
  ],engine, context.subscriptions);
  let stop = vscode.commands.registerCommand(
    'tsar.stop', (uri:vscode.Uri) => engine.stop(uri));
  let statistic = vscode.commands.registerCommand(
    'tsar.statistic', (data: vscode.Uri|Project) => {
      let project = (data as Project).prjname !== undefined
        ? data as Project
        : engine.project(data as vscode.Uri);
      let state = project.providerState(ProjectProvider.scheme);
      let request = new msg.Statistic;
      state.active = true;
      project.focus = state;
      project.send(request);
    }
  );
  let openProject = vscode.commands.registerCommand('tsar.open-project',
    (uri: vscode.Uri) => {
      let [docUri, query] = [uri, undefined];
      if (uri.query != '') {
        query = JSON.parse(uri.query);
        docUri = vscode.Uri.file(query['Path']);
      } else {
        docUri = vscode.Uri.file(uri.path);
      }
      vscode.workspace.openTextDocument(docUri).then(
        (success) => {
          vscode.window.showTextDocument(success).then(
            (doc) => {
              if (query && 'Line' in query) {
                let line = query.Line;
                let col = query.Column;
                doc.selection =
                  new vscode.Selection(line - 1, col - 1, line - 1, col - 1);
                doc.revealRange(
                  new vscode.Range(line - 1, col - 1, line - 1, col - 1));
              }
            }
          )
        },
        () => {
          vscode.window.showErrorMessage(
            `${log.Extension.displayName}: ${log.Error.openFile.replace('{0}', uri.fsPath)}`);
        })
    });
  lt.registerCommands(engine, context.subscriptions);
  at.registerCommands(engine, context.subscriptions);
  let showCalleeFunc = vscode.commands.registerCommand('tsar.callee.func',
    (uri:vscode.Uri) => {
      let project = engine.project(uri);
      let state = project.providerState(
        CalleeFuncProvider.scheme) as CalleeFuncProviderState;
      let request = new msg.CalleeFuncList;
      let query = JSON.parse(uri.query);
      request.FuncID = query.FuncID;
      request.Attr = query.Attr;
      request.LoopID = 'LoopID' in query ? query.LoopID : 0;
      // Dispose current webview if required request is new.
      state.active = false;
      state.active = true;
      project.focus = state;
      project.send(request);
    });
  context.subscriptions.push(start, stop, statistic, openProject, showCalleeFunc, gitGraph);
}
