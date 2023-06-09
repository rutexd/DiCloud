import { ChannelType, Client, ClientOptions, FetchMessagesOptions, Guild, GuildBasedChannel, Message, TextBasedChannel, TextChannel } from 'discord.js';
import color from 'colors/safe.js';
import DiscordFileManager from './RemoteFileManager.js';
import axios from './helper/AxiosInstance.js';
import RemoteFile from './file/RemoteFile.js';
import { VirtualFS } from './file/filesystem/Folder.js';
import { make } from './Log.js';

export interface DiscordFileStorageAppOptions extends ClientOptions {
    metaChannelName: string;
    filesChannelName: string;

    shouldEncrypt: boolean;
    encryptPassword?: string;
}

/**
 * Main class of the DiscordFileStorageApp. It is a Discord.js client with some additional functionality.
 */
export default class DiscordFileStorageApp extends Client {

    private guildId: string;
    private metaChannelName: string;
    private filesChannelId: string;
    private channelsToCreate: Array<string>;
    private discordFileManager: DiscordFileManager;
    private filesystem: VirtualFS = new VirtualFS();

    private shouldEncrypt;
    private encryptPassword;

    public static instance: DiscordFileStorageApp;
    private logger = make("DiscordFileStorageApp", true);

    constructor(options: DiscordFileStorageAppOptions, guildId: string) {
        super(options);
        if (DiscordFileStorageApp.instance) {
            throw new Error("DiscordFileStorageApp already exists");
        }
        DiscordFileStorageApp.instance = this;

        this.channelsToCreate = [
            options.metaChannelName,
            options.filesChannelName
        ];

        this.metaChannelName = options.metaChannelName;
        this.filesChannelId = options.filesChannelName;

        this.shouldEncrypt = options.shouldEncrypt;
        this.encryptPassword = options.encryptPassword ?? "";

        this.guildId = guildId;
        this.discordFileManager = new DiscordFileManager(this);

    }

    public shouldEncryptFiles(): boolean {
        return this.shouldEncrypt;
    }

    public getEncryptPassword(): string {
        return this.encryptPassword;
    }


    public async getGuild(): Promise<Guild> {
        return this.guilds.cache.get(this.guildId)!.fetch();
    };

    public async getMetadataChannel(): Promise<TextBasedChannel> {
        return (await this.getGuild()).channels.cache.find(channel => channel.name == this.metaChannelName) as TextBasedChannel;
    }

    public async getFileChannel(): Promise<TextBasedChannel> {
        return (await this.getGuild()).channels.cache.find(channel => channel.name == this.filesChannelId) as TextBasedChannel;
    }

    public async waitForReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.once("ready", resolve as any);
        });
    }

    public async prepare() {
        const guilds = this.guilds.cache;
        if (!guilds.has(this.guildId)) {
            printAndExit("Guild not found");
        }

        const guild = await guilds.get(this.guildId)?.fetch()!;
        if (!guild) {
            printAndExit("Failed to fetch guild: " + this.guildId);
        }
        
        this.logger.info("Guild found: " + guild.name);
        console.log(color.yellow("Fetching channels..."));
        await guild.channels.fetch();
        let guildChannels = guild.channels.cache.filter(channel => channel.type == ChannelType.GuildText);
        for (const channelToCreate of this.channelsToCreate) {
            if (!guildChannels.some(channel => channel.name == channelToCreate)) {
                console.log("creating channel: " + channelToCreate);
                await guild.channels.create({
                    name: channelToCreate,
                    type: ChannelType.GuildText,
                });
            } else {
                console.log(color.green("channel already exists: " + channelToCreate));
            }
        }
    }

    async getAllMessages(channelId: string): Promise<Message[]> {
        const channel = await this.channels.fetch(channelId) as TextChannel;
        let allMessages: Message[] = [];
        let lastId: string | undefined;

        while (true) {
            const options: FetchMessagesOptions = { limit: 100 };
            if (lastId) {
                options.before = lastId;
            }

            const messages = [... (await channel.messages.fetch(options)).values()];

            allMessages = allMessages.concat(messages);
            console.log("[getAllMessages] got block of " + messages.length + " messages")
            if (messages.length < 100) {
                break;
            }

            lastId = messages.pop()!.id;
        }

        return allMessages;
    }

    public getFileSystem(): VirtualFS {
        return this.filesystem;
    }

    /**
     * loadFiles
     */
    public async loadFiles() {
        console.log(color.yellow("Fetching files... This may take a while if there are a lot of files"))
        let totalLoadedFiles = 0;
        let failedFiles = 0;

        const metaDataChannelId = (await this.getMetadataChannel()).id;
        let messages = (await this.getAllMessages(metaDataChannelId));
        console.log("Got " + messages.length + " meta information messages, parsing...");
        console.log();
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            if (msg.attachments.size > 0) {
                let file = (await axios.get(msg.attachments.first()!.url)).data as object;

                console.log("Loading file " + i + "/" + messages.length + " " + msg.attachments.first()!.name);
                console.log(file);
                if (RemoteFile.isValidRemoteFile(file)) {
                    const remoteFile = RemoteFile.fromObject(file as any, this.filesystem);
                    remoteFile.setMessageMetaIdInMetaChannel(msg.id);

                    console.log("Loaded file " + remoteFile.getFileName() + " at " + remoteFile.getAbsolutePath());
                } else {
                    console.log("Failed to extract valid message data");
                    console.log(file);
                    failedFiles++;
                }
                totalLoadedFiles++;
            } else {
                console.log("Message has no attachments");
            }
        }

        console.log(); // little bit debug
        console.log("Readen " + totalLoadedFiles + " files");
        console.log("Success loadeded " + (totalLoadedFiles - failedFiles) + " / " + totalLoadedFiles + " files. " + "(" +( totalLoadedFiles - failedFiles) / totalLoadedFiles * 100 + "%)")
        console.log();

    }

    public async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public getDiscordFileManager(): DiscordFileManager {
        return this.discordFileManager;
    }


    public getLogger() {
        return this.logger;
    }


    

}


export function printAndExit(message: string, exitCode: number = 1) {
    console.log(color.red(message));
    process.exit(exitCode);
}


export function print(message: string) {
    console.log(color.green(message));
}