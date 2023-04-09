import { FileStat, WebDAVClient, createClient } from "webdav"
import { assert } from "chai";
import { before, after, describe, it } from "mocha";
import DiscordFileStorageApp from "../src/DiscordFileStorageApp.js";
import { bootApp } from "../bootloader.js";
import sinon, { SinonStub } from "sinon";
import { Readable, Writable } from "stream";
import fs from "fs";
import path from "path";
import crypro from "crypto";
import axios from "../src/helper/AxiosInstance.js";
import { patchEmitter } from "../src/helper/EventPatcher.js";

const DOMAIN = "localhost";
const PORT = 3000;


function md5(buffer: Buffer) {
	return crypro.createHash("md5").update(buffer).digest("hex");
}

async function sleep(t: number) {
	return new Promise((resolve, reject) => {
		setTimeout(resolve, t);
	})
}


async function fillWileWithData(sizeInBytes: number, stream: Writable) {
	return new Promise((resolve, reject) => {

		const buffer = Buffer.alloc(sizeInBytes);
		for (let i = 0; i < sizeInBytes; i++) {
			buffer[i] = Math.floor(Math.random() * 256);
		}
		stream.write(buffer);
		stream.on("finish", () => {
			resolve(true);
		});
		stream.on("error", (err) => {
			reject(err);
		});
		stream.end();
	});
}

function randomString(n: number = 16) {
	let result = "";
	const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const charactersLength = characters.length;
	for (let i = 0; i < n; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}


function generateRandomString(n: number = 16) {
	let result = "";
	const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const charactersLength = characters.length;
	for (let i = 0; i < n; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}

process.on("unhandledRejection", (reason, promise) => {
	console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
	console.error("Uncaught Exception at:", err);
});



describe("DICloud basic functions test", function () {
	let fileLogStream: Writable = fs.createWriteStream("logs/console_log.log", {
		flags: "w+"
	});

	let logStub: SinonStub;
	let warnStub: SinonStub;

	before(() => {
		// prints all console.log to a file. if its a string, removes the control escape characters. if type cannot be casted to string, like symbol, it will be ignored.
		logStub = sinon.stub(console, "log").callsFake((...args) => {
			for (let i = 0; i < args.length; i++) {
				if (typeof args[i] === "string") {
					fileLogStream.write(args[i].replace(/\x1b\[[0-9;]*m/g, "") + "\n");
				}
			}
		});

		warnStub = sinon.stub(console, "warn");
	});

	after(() => {
		logStub.restore();
		warnStub.restore();
	});

	after(() => {
		process.exit(0);
	})

	let server: DiscordFileStorageApp;

	// TODO: options
	let client: WebDAVClient;

	it("Prepares the test environment", async function () {
		if (fs.existsSync(".local")) {
			return true;
		}
		fs.mkdirSync(".local");
		assert.isTrue(fs.existsSync(".local"));
	});



	let localTestFolderName: string;
	let localGeneratedFilePath: string;
	it("Generate random 10MB file on a local filesystem", async function () {
		let randomLocalFolderName = randomString();
		localTestFolderName = randomLocalFolderName;
		let randomLocalFileName = randomString();
		fs.mkdirSync(path.join(".local", randomLocalFolderName), { recursive: true });
		localGeneratedFilePath = path.join(".local", randomLocalFolderName, randomLocalFileName + ".txt");

		await fillWileWithData(1024 * 1024 * 10, fs.createWriteStream(localGeneratedFilePath, {
			flags: "w"
		}));

		assert.isTrue(fs.existsSync(localGeneratedFilePath));
	});


	it("Start the server and ensure server is up", async function () {
		this.timeout(10000);

		server = await bootApp();
		client = createClient(`http://${DOMAIN}:${PORT}`);

		assert.isArray(await client.getDirectoryContents("/"))
	});


	let remoteFolderName = generateRandomString();
	it("Create a remote temponary folder: " + remoteFolderName, async function () {
		await client.createDirectory(remoteFolderName);
		const content = (await client.getDirectoryContents("/") as FileStat[]).filter((file) => file.type === "directory");

		assert.equal(content.find((file) => file.basename === remoteFolderName) !== undefined, true);
	});

	it("Upload a local generated file to the remote created folder", async function () {
		this.timeout(5000);
		return new Promise(async (resolve, reject) => {
			const fsReadableStream = fs.createReadStream(localGeneratedFilePath);

			const fileUploaded = await client.putFileContents(`${remoteFolderName}/testfile.txt`, fsReadableStream);
			await sleep(500);

			if (fileUploaded) {
				resolve();
			} else {
				reject();
			}
		});
	});

	it("Check if the remote file exists: " + remoteFolderName + "/testfile.txt", async function () {
		const content = (await client.getDirectoryContents(remoteFolderName) as FileStat[]).filter((file) => file.type === "file");
		assert.equal(content.find((file) => file.basename === "testfile.txt") !== undefined, true);
	});

	let localRecreatedUploadedFile = path.join(".local", "testfile-downloaded.txt");
	it("Download remote created file: " + `${remoteFolderName}/testfile.txt -> ${localRecreatedUploadedFile}`, async function () {
		this.timeout(10000);

		return new Promise(async (resolve, reject) => {
			client.createReadStream(`/${remoteFolderName}/testfile.txt`).pipe(fs.createWriteStream(localRecreatedUploadedFile)).on("finish", () => {
				resolve();
			});
		});
	});

	it("checks md5 hash of the original and downloaded file", async function () {
		const localFileMD5 = md5(fs.readFileSync(localGeneratedFilePath));
		const downloadedFileMD5 = md5(fs.readFileSync(localRecreatedUploadedFile));


		assert.equal(localFileMD5, downloadedFileMD5);
	});


	it("put new file contents to the remote file, transfers the file from RAM to being real uploaded file", async function () {
		this.timeout(5000);
		// logStub.restore();
		console.log("put new file contents");

		let success = await client.putFileContents(`${remoteFolderName}/testfile.txt`, "Hello World");
		await sleep(1000);
		assert.equal(success, true);
	});

	it("Checks if remote file content is actually changed", async function () {
		this.timeout(5000);

		const content = await client.getFileContents(`${remoteFolderName}/testfile.txt`);
		console.log("file content", content);
		assert.equal(content, "Hello World");
	});

	let randomNewName = randomString();
	it("rename a remote file in " + randomNewName, async function () {
		this.timeout(5000);

		await client.moveFile(`${remoteFolderName}/testfile.txt`, `${remoteFolderName}/${randomNewName}.txt`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === randomNewName + ".txt") !== undefined, true);
	});

	it("rename a remote file back to testfile.txt", async function () {
		this.timeout(5000);

		await client.moveFile(`${remoteFolderName}/${randomNewName}.txt`, `${remoteFolderName}/testfile.txt`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === "testfile.txt") !== undefined, true);
	});

	let randomNewFolderName = randomString();
	it("rename a remote folder " + remoteFolderName + " -> " + randomNewFolderName, async function () {
		this.timeout(5000);

		await client.moveFile(`${remoteFolderName}`, `${randomNewFolderName}`);

		const content = await client.getDirectoryContents(`/`) as FileStat[];
		assert.equal(content.find((file) => file.basename === randomNewFolderName) !== undefined, true);
	});

	it("rename a remote folder back " + randomNewFolderName + " -> " + remoteFolderName, async function () {
		this.timeout(5000);

		await client.moveFile(`${randomNewFolderName}`, `${remoteFolderName}`);

		const content = await client.getDirectoryContents(`/`) as FileStat[];
		assert.equal(content.find((file) => file.basename === remoteFolderName) !== undefined, true);
	});


	let localSubFolderName = "subfolder";
	it("Create a new folder (" + localSubFolderName + ") on the server in created directory (" + remoteFolderName + ")", async function () {
		await client.createDirectory(`${remoteFolderName}/${localSubFolderName}`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === localSubFolderName) !== undefined, true);
	});

	it("moves testfile.txt to the subfolder", async function () {
		await client.moveFile(`${remoteFolderName}/testfile.txt`, `${remoteFolderName}/${localSubFolderName}/testfile.txt`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}/${localSubFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === "testfile.txt") !== undefined, true);
	});

	it("moves testfile.txt back to the temponary folder", async function () {
		await client.moveFile(`${remoteFolderName}/${localSubFolderName}/testfile.txt`, `${remoteFolderName}/testfile.txt`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === "testfile.txt") !== undefined, true);
	});

	it("delete subfolder", async function () {
		await client.deleteFile(`${remoteFolderName}/${localSubFolderName}`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === localSubFolderName) == undefined, true);
	});

	it("checks if the testfile is still there", async function () {
		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];
		assert.equal(content.find((file) => file.basename === "testfile.txt") !== undefined, true);
	});

	it("Checks if md5 is still valid", async function () {
		const fileContent = await client.getFileContents(`${remoteFolderName}/testfile.txt`) as string;
		const fileMD5 = md5(Buffer.from(fileContent));

		assert.equal(fileMD5, md5(Buffer.from("Hello World")));
	});



	it("Tries to download uploaded file via http", async function () {
		this.timeout(10000);
		return new Promise(async (resolve, reject) => {
			const content = (await client.getDirectoryContents("/") as FileStat[]).filter((file) => file.type === "file");
			assert.isAbove(content.length, 0, "No files found in the root directory");

			let downloadUrl = client.getFileDownloadLink(`/${remoteFolderName}/testfile.txt`);
			let stream = await axios.get(downloadUrl, {
				responseType: "stream"
			});

			stream.data.on("data", (data: any) => {
				(stream.data as Readable).destroy();
				resolve();
			});

			stream.data.on("error", (err: any) => {
				reject(err);
			});

		});
	});


	it("Delete a uploaded file from the server", async function () {
		this.timeout(5000);
		await client.deleteFile(`${remoteFolderName}/testfile.txt`);

		const content = await client.getDirectoryContents(`/${remoteFolderName}`) as FileStat[];

		assert.equal(content.find((file) => file.basename === "testfile.txt") == undefined, true);
	});

	it("Delete a folder from the server", async function () {
		await client.deleteFile(`${remoteFolderName}`);

		const content = await client.getDirectoryContents(`/`) as FileStat[];
		assert.equal(content.find((file) => file.basename === remoteFolderName) == undefined, true);
	});

	it("Delete local created folder and files", async function () {

		let folder = path.join(".local", localTestFolderName);
		fs.rmSync(folder, { recursive: true });
		fs.unlinkSync(localRecreatedUploadedFile);

		assert.equal(fs.existsSync(localRecreatedUploadedFile), false, "local recreated file still exists");
		assert.equal(fs.existsSync(folder), false, "local test folder still exists");
	});


	it("Open stream to not existing file", async function () {
		this.timeout(5000);
		return new Promise((resolve, reject) => {
			let stream = client.createReadStream("not-existing-file.txt");
			stream.on("error", (err) => {
				resolve();
			});

			stream.on("data", (data) => {
				stream.destroy();
				reject();
			});

		});
	});

	it("Open stream to not existing file in not existing folder", async function () {
		this.timeout(5000);
		return new Promise((resolve, reject) => {
			let stream = client.createReadStream("/not-existing-folder/test.txt");
			stream.on("error", (err) => {
				resolve();
			});

			stream.on("data", (data) => {
				stream.destroy();
				reject();
			});

		});
	});

});