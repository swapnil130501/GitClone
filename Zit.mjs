#!/usr/bin/env node
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { diffLines } from 'diff';
import chalk from 'chalk';
import { Command } from 'commander';

const program = new Command();

class Zit {
    constructor(repoPath = ".") {
        this.repoPath = path.join(repoPath, '.zit');
        this.objectsPath = path.join(this.repoPath, 'objects'); // .zit/objects
        this.headPath = path.join(this.repoPath, 'HEAD'); // .zit/HEAD
        this.indexPath = path.join(this.repoPath, 'index'); // .zit/index
        this.init();
    }

    async init() {
        await fs.mkdir(this.objectsPath, { recursive: true });
        try {
            await fs.writeFile(this.headPath, '', { flag: 'wx' }); // w: write, x: exclusive (open for writing, fail if file exists)
            await fs.writeFile(this.indexPath, JSON.stringify([], null, 2), { flag: 'wx' }); // prettier JSON
        } catch (error) {
            console.log("Already initialized .zit folder");
        }
    }

    hashObject(content) {
        return crypto.createHash('sha1').update(content, 'utf-8').digest('hex'); // update -> creates a hash of a content, digest -> calculates final value in hex
    }

    async add(fileToBeAdded) {
        try {
            const fileData = await fs.readFile(fileToBeAdded, { encoding: 'utf-8' }); // read the file
            const fileHash = this.hashObject(fileData); // hash the file
            console.log(`File Hash: ${fileHash}`);
            const newHashedObjectPath = path.join(this.objectsPath, fileHash); // .zit/objects/abc123

            // Check if the object already exists to avoid duplicate writes
            try {
                await fs.access(newHashedObjectPath);
                console.log("File content already stored.");
            } catch {
                await fs.writeFile(newHashedObjectPath, fileData);
            }

            await this.updateStagingArea(fileToBeAdded, fileHash);
            console.log(`Added ${fileToBeAdded} to staging area.`);
        } catch (error) {
            console.error(`Failed to add file ${fileToBeAdded}:`, error);
        }
    }

    async updateStagingArea(filePath, fileHash) {
        try {
            const indexRaw = await fs.readFile(this.indexPath, { encoding: 'utf-8' }); // read the index file
            const index = JSON.parse(indexRaw);
            // Check if the file is already staged; if so, update the hash
            const existingIndex = index.find(entry => entry.path === filePath);
            if (existingIndex) {
                existingIndex.hash = fileHash;
            } else {
                index.push({ path: filePath, hash: fileHash }); // add file to the index
            }
            await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
        } catch (error) {
            console.error("Failed to update staging area:", error);
        }
    }

    async commit(message) {
        try {
            const indexRaw = await fs.readFile(this.indexPath, { encoding: 'utf-8' });
            const index = JSON.parse(indexRaw);
            if (index.length === 0) {
                console.log("Nothing to commit. Staging area is empty.");
                return;
            }

            const parentCommit = await this.getCurrentHead();

            const commitData = {
                timeStamp: new Date().toISOString(),
                message,
                files: index,
                parent: parentCommit || null
            };

            const commitHash = this.hashObject(JSON.stringify(commitData));
            const commitPath = path.join(this.objectsPath, commitHash);
            await fs.writeFile(commitPath, JSON.stringify(commitData, null, 2));
            await fs.writeFile(this.headPath, commitHash); // update the head to point to the new commit
            await fs.writeFile(this.indexPath, JSON.stringify([], null, 2)); // clear the staging area

            console.log(`Commit successfully created: ${commitHash}`);
        } catch (error) {
            console.error("Failed to create commit:", error);
        }
    }

    async getCurrentHead() {
        try {
            const head = await fs.readFile(this.headPath, { encoding: 'utf-8' });
            return head.trim() || null;
        } catch (error) {
            return null; // for the first commit (root node)
        }
    }

    async log() {
        try {
            let currentCommitHash = await this.getCurrentHead();
            if (!currentCommitHash) {
                console.log("No commits yet.");
                return;
            }

            while (currentCommitHash) {
                const commitDataRaw = await this.getCommitData(currentCommitHash);
                if (!commitDataRaw) {
                    console.log(`Commit data for ${currentCommitHash} not found.`);
                    break;
                }

                const commitData = JSON.parse(commitDataRaw);
                console.log(`-------------------\n`);
                console.log(`Commit: ${currentCommitHash}`);
                console.log(`Date: ${commitData.timeStamp}`);
                console.log(`\n\t${commitData.message}\n`);
                currentCommitHash = commitData.parent; // Traverse to the parent commit
            }
        } catch (error) {
            console.error("Failed to display log:", error);
        }
    }

    async showCommitDiff(commitHash) {
        const commitDataRaw = await this.getCommitData(commitHash);
        if (!commitDataRaw) {
            console.log("Commit not found");
            return;
        }

        const commitData = JSON.parse(commitDataRaw);
        console.log("Changes in the commit are:");

        for (const file of commitData.files) {
            console.log(`\nFile: ${file.path}`);
            const fileContent = await this.getFileContent(file.hash);
            console.log(fileContent);

            if (commitData.parent) {
                // Get the parent commit data
                const parentCommitDataRaw = await this.getCommitData(commitData.parent);
                if (!parentCommitDataRaw) {
                    console.log("Parent commit data not found");
                    continue;
                }

                const parentCommitData = JSON.parse(parentCommitDataRaw);
                const parentFileContent = await this.getParentFileContent(parentCommitData, file.path);

                if (parentFileContent !== undefined) { 

                    const diff = diffLines(parentFileContent, fileContent);
                    
                    diff.forEach(part => {
                        if (part.added) {
                            process.stdout.write(chalk.green("++" + part.value));
                        } else if (part.removed) {
                            process.stdout.write(chalk.red("--" +part.value));
                        } else {
                            process.stdout.write(chalk.grey(part.value));
                        }
                    });

                    console.log(); // Add a newline after the diff
                } else {
                    console.log("New file in this commit");
                }
            } else {
                console.log("First commit");
            }
        }
    }

    async getParentFileContent(parentCommitData, filePath) {
        const parentFile = parentCommitData.files.find(file => file.path === filePath);
        if (parentFile) {
            return await this.getFileContent(parentFile.hash);
        }
        return undefined;
    }

    async getCommitData(commitHash) {
        const commitPath = path.join(this.objectsPath, commitHash);
        try {
            const data = await fs.readFile(commitPath, { encoding: 'utf-8' });
            return data;
        } catch (error) {
            console.log(`Failed to read the commit data for ${commitHash}:`, error);
            return null;
        }
    }

    async getFileContent(fileHash) {
        const objectPath = path.join(this.objectsPath, fileHash);
        try {
            const content = await fs.readFile(objectPath, { encoding: 'utf-8' });
            return content;
        } catch (error) {
            console.log(`Failed to read file content for hash ${fileHash}:`, error);
            return null;
        }
    }
}

// (async () => {
//     const zit = new Zit();
//     // await zit.add('sample.txt');
//     // await zit.add('sample2.txt');
//     // await zit.commit('second commit');
//     // await zit.log();
//     await zit.showCommitDiff('995ade22c116cb8fdb5bb9f98363688da4667400');
// })();

program
    .version('1.0.0')
    .description('Zit - A Simple Version Control System');

// Define the 'init' command
program
    .command('init')
    .description('Initialize a new Zit repository')
    .action(async () => {
        const zit = new Zit();
        // The constructor handles initialization and logs the result
    });

// Define the 'add' command
program
    .command('add <file>')
    .description('Add a file to the staging area')
    .action(async (file) => {
        const zit = new Zit();
        await zit.add(file);
    });

// Define the 'commit' command
program
    .command('commit <message>')
    .description('Commit staged changes with a message')
    .action(async (message) => {
        const zit = new Zit();
        await zit.commit(message);
    });

// Define the 'log' command
program
    .command('log')
    .description('Show commit logs')
    .action(async () => {
        const zit = new Zit();
        await zit.log();
    });

// Define the 'show' command
program
    .command('show <commitHash>')
    .description('Show the diff of a specific commit')
    .action(async (commitHash) => {
        const zit = new Zit();
        await zit.showCommitDiff(commitHash);
    });

// Parse the command-line arguments
program.parse(process.argv);

// If no arguments were provided, display help
if (!process.argv.slice(2).length) {
    program.outputHelp();
}
