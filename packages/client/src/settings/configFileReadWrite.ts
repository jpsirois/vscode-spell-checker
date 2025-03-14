import type { CSpellPackageSettings, CSpellSettings } from '@cspell/cspell-types';
import { assign as assignJson, parse as parseJsonc, stringify as stringifyJsonc } from 'comment-json';
import { Uri } from 'vscode';
import { Utils as UriUtils } from 'vscode-uri';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { CSpellUserSettings } from '../client';
import type { ConfigReaderWriter, ConfigUpdateFn } from './configReaderWriter';
import { extractKeys } from './configReaderWriter';
import { vscodeFs as fs } from './fs';
export type { ConfigUpdateFn } from './configReaderWriter';

const SymbolFormat = Symbol('format');

type HandlerDef = { match: RegExp; handler: (uri: Uri) => ConfigFileReaderWriter };

const handlers: HandlerDef[] = [
    { match: /package\.json$/i, handler: (uri) => new ConfigFileReaderWriterPackage(uri) },
    { match: /\.jsonc?$/i, handler: (uri) => new ConfigFileReaderWriterJson(uri) },
    { match: /\.ya?ml$/i, handler: (uri) => new ConfigFileReaderWriterYaml(uri) },
];

const spacesJson = 4;
const spacesPackage = 2;

interface ObjectWithFormatting {
    [SymbolFormat]?: ContentFormat;
}

/**
 *
 * @param uri - uri of the configuration file.
 * @param updateFn - function to be called with the config data to be updated. It should only return the fields to be update.
 *  A fields with a value of `undefined` will be removed from the file.
 *
 * @returns resolves if successful.
 */
export function updateConfigFile(uri: Uri, updateFn: ConfigUpdateFn): Promise<void> {
    const rw = createConfigFileReaderWriter(uri);
    return rw._update(updateFn);
}

export function readConfigFile(uri: Uri, defaultValueIfNotFound: CSpellSettings): Promise<CSpellSettings>;
export function readConfigFile(uri: Uri, defaultValueIfNotFound?: CSpellSettings): Promise<CSpellSettings | undefined>;
export async function readConfigFile(uri: Uri, defaultValueIfNotFound?: CSpellSettings): Promise<CSpellSettings | undefined> {
    try {
        const rw = createConfigFileReaderWriter(uri);
        return await rw._read();
    } catch (e) {
        if (fs.isFileNotFoundError(e)) {
            return Promise.resolve(defaultValueIfNotFound);
        }
        return Promise.reject(e);
    }
}

export function writeConfigFile(uri: Uri, cfg: CSpellSettings): Promise<void> {
    const rw = createConfigFileReaderWriter(uri);
    return rw.write(cfg);
}

export function isHandled(uri: Uri): boolean {
    return !!matchHandler(uri);
}

export function createConfigFileReaderWriter(uri: Uri): ConfigFileReaderWriter {
    return mustMatchHandler(uri);
}

function mustMatchHandler(uri: Uri): ConfigFileReaderWriter {
    const h = matchHandler(uri);
    if (h) return h.handler(uri);
    throw new UnhandledFileType(uri);
}

function matchHandler(uri: Uri): HandlerDef | undefined {
    const u = uri.with({ fragment: '', query: '' });
    const s = u.toString();
    for (const h of handlers) {
        if (!h.match.test(s)) continue;
        return h;
    }
    return undefined;
}

const settingsFileTemplate: CSpellSettings = {
    version: '0.2',
    ignorePaths: [],
    dictionaryDefinitions: [],
    dictionaries: [],
    words: [],
    ignoreWords: [],
    import: [],
};

interface PackageWithCSpell {
    cspell?: CSpellPackageSettings;
}

function orDefault<T>(p: Promise<T>, defaultValue: T): Promise<T> {
    return p.catch((e) => {
        if (!fs.isFileNotFoundError(e)) throw e;
        return defaultValue;
    });
}

export class UnhandledFileType extends Error {
    constructor(uri: Uri) {
        super(`Unhandled file type: "${UriUtils.basename(uri)}"`);
    }
}

export class SysLikeError extends Error {
    constructor(
        msg?: string,
        readonly code?: string,
        readonly errno?: number,
    ) {
        super(msg);
    }
}

export class FormatError extends Error {
    constructor(msg: string) {
        super(msg);
    }
}

export function parseJson(content: string): CSpellSettings {
    const formatting = detectFormatting(content);
    const json = parseJsonc(content);
    if (json === null || json === undefined) return {};
    if (typeof json !== 'object') {
        throw new FormatError('Invalid cspell JSON file.');
    }
    return injectFormatting<CSpellSettings>(json as CSpellSettings, formatting);
}

export function stringifyJson(obj: unknown, spaces?: string | number | undefined, keepComments = true): string {
    const formatting = retrieveFormatting(obj);
    spaces = formatting?.spaces || spaces || spacesJson;
    const newlineAtEndOfFile = formatting?.newlineAtEndOfFile ?? true;
    const json = keepComments ? stringifyJsonc(obj, null, spaces) : JSON.stringify(obj, null, spaces);
    return newlineAtEndOfFile ? json + '\n' : json;
}

function injectFormatting<T>(s: T, format: ContentFormat): T {
    if (s === undefined || s === null || typeof s !== 'object') return s;
    (<ObjectWithFormatting>s)[SymbolFormat] = format;
    return s;
}

function retrieveFormatting<T>(s: T): ContentFormat | undefined {
    if (s === undefined || s === null || typeof s !== 'object') return undefined;
    return (<ObjectWithFormatting>s)[SymbolFormat];
}

interface ContentFormat {
    spaces: string | number | undefined;
    newlineAtEndOfFile: boolean;
}

function hasTrailingNewline(content: string): boolean {
    return /\n$/.test(content);
}

function detectIndent(json: string): string | undefined {
    const s = json.match(/^[ \t]+(?=")/m);
    if (!s) return undefined;
    return s[0];
}

function detectFormatting(content: string): ContentFormat {
    return {
        spaces: detectIndent(content),
        newlineAtEndOfFile: hasTrailingNewline(content),
    };
}

export interface ConfigFileReaderWriter extends ConfigReaderWriter {
    readonly uri: Uri;
    _update(fn: ConfigUpdateFn): Promise<void>;
    _read(): Promise<CSpellUserSettings>;
}

abstract class AbstractConfigFileReaderWriter implements ConfigFileReaderWriter {
    constructor(readonly uri: Uri) {}

    async read<K extends keyof CSpellUserSettings>(keys: K[]): Promise<Pick<CSpellUserSettings, K>> {
        return extractKeys(await this._read(), keys);
    }

    abstract _read(): Promise<CSpellUserSettings>;
    abstract write(settings: CSpellSettings): Promise<void>;

    update<K extends keyof CSpellUserSettings>(fn: ConfigUpdateFn, keys: K[]): Promise<void> {
        return this._update((cfg) => fn(extractKeys(cfg, keys)));
    }

    abstract _update(fn: ConfigUpdateFn): Promise<void>;

    async mkdir(): Promise<void> {
        return await fs.createDirectory(Uri.joinPath(this.uri, '..'));
    }
}

class ConfigFileReaderWriterJson extends AbstractConfigFileReaderWriter {
    async _update(updateFn: ConfigUpdateFn): Promise<void> {
        const cspell = await orDefault(this._read(), settingsFileTemplate);
        const updated = assignJson(cspell, updateFn(cspell));
        return this.write(updated);
    }

    async write(cfg: CSpellSettings): Promise<void> {
        await this.mkdir();
        const json = stringifyJson(cfg);
        const content = json[json.length - 1] !== '\n' ? json + '\n' : json;
        return fs.writeFile(this.uri, content);
    }

    async _read(): Promise<CSpellSettings> {
        const uri = this.uri;
        const content = await fs.readFile(uri, 'utf8');
        const s = parseJson(content) as CSpellSettings;
        return s;
    }
}

class ConfigFileReaderWriterPackage extends AbstractConfigFileReaderWriter {
    async _update(updateFn: ConfigUpdateFn): Promise<void> {
        const content = await fs.readFile(this.uri, 'utf8');
        const pkg = parseJson(content) as PackageWithCSpell;
        const cspell = pkg.cspell || { ...settingsFileTemplate };
        pkg.cspell = Object.assign(cspell, updateFn(cspell));
        return fs.writeFile(this.uri, stringifyJson(pkg, spacesPackage, false));
    }

    async write(cfg: CSpellSettings): Promise<void> {
        const content = await fs.readFile(this.uri, 'utf8');
        const pkg = parseJson(content) as PackageWithCSpell;
        pkg.cspell = cfg;
        return fs.writeFile(this.uri, stringifyJson(pkg, spacesPackage, false));
    }

    async _read(): Promise<CSpellSettings> {
        const content = await fs.readFile(this.uri, 'utf8');
        const pkg = parseJson(content) as { cspell?: CSpellPackageSettings };
        if (!pkg.cspell || typeof pkg.cspell !== 'object') {
            throw new SysLikeError('`cspell` section missing from package.json', 'ENOENT');
        }
        return pkg.cspell;
    }
}

class ConfigFileReaderWriterYaml extends AbstractConfigFileReaderWriter {
    async _update(updateFn: ConfigUpdateFn): Promise<void> {
        const cspell = await orDefault(this._read(), settingsFileTemplate);
        const updated = Object.assign({}, cspell, updateFn(cspell));
        return this.write(updated);
    }

    async write(cfg: CSpellSettings): Promise<void> {
        await this.mkdir();
        return fs.writeFile(this.uri, stringifyYaml(cfg));
    }

    async _read(): Promise<CSpellSettings> {
        const content = await fs.readFile(this.uri, 'utf8');
        return parseYaml(content) as CSpellSettings;
    }
}

export const __testing__ = {
    settingsFileTemplate,
    detectIndent,
    injectFormatting,
    SymbolFormat,
};
