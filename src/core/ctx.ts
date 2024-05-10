import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, promises as fs } from 'node:fs'
import process from 'node:process'
import { slash, throttle, toArray } from '@antfu/utils'
import { createFilter } from '@rollup/pluginutils'
import { isPackageExists } from 'local-pkg'
import type { Import, InlinePreset } from 'unimport'
import { createUnimport, resolvePreset, scanExports } from 'unimport'
import fg from 'fast-glob'

// @ts-expect-error types
import { vueTemplateAddon } from 'unimport/addons'
import MagicString from 'magic-string'
import { presets } from '../presets'
import type { ESLintGlobalsPropValue, ESLintrc, ImportExtended, Options } from '../types'
import { generateESLintConfigs } from './eslintrc'
import { resolversAddon } from './resolvers'

function resolveGlobsExclude(root: string, glob: string) {
  const excludeReg = /^!/
  return `${excludeReg.test(glob) ? '!' : ''}${resolve(root, glob.replace(excludeReg, ''))}`
}

async function scanDirExports(dirs: string[], root: string) {
  const result = await fg(dirs, {
    absolute: true,
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: true,
  })

  const files = Array.from(new Set(result.flat())).map(slash)
  return (await Promise.all(files.map(i => scanExports(i, false)))).flat()
}

export function createContext(options: Options = {}, root = process.cwd()) {
  root = slash(root)

  const {
    dts: preferDTS = isPackageExists('typescript'),
  } = options

  const dirs = options.dirs?.concat(options.dirs.map(dir => join(dir, '*.{tsx,jsx,ts,js,mjs,cjs,mts,cts}')))
    .map(dir => slash(resolveGlobsExclude(root, dir)))

  const eslintrc: ESLintrc = options.eslintrc || {}
  eslintrc.enabled = eslintrc.enabled === undefined ? false : eslintrc.enabled
  eslintrc.filepath = eslintrc.filepath || './.eslintrc-auto-import.json'
  eslintrc.globalsPropValue = eslintrc.globalsPropValue === undefined ? true : eslintrc.globalsPropValue

  const resolvers = options.resolvers ? [options.resolvers].flat(2) : []

  // When "options.injectAtEnd" is undefined or true, it's true.
  const injectAtEnd = options.injectAtEnd !== false

  const unimport = createUnimport({
    imports: [],
    presets: options.packagePresets?.map(p => typeof p === 'string' ? { package: p } : p) ?? [],
    injectAtEnd,
    parser: options.parser,
    addons: [
      ...(options.vueTemplate ? [vueTemplateAddon()] : []),
      resolversAddon(resolvers),
      {
        declaration(dts) {
          return `${`
/* eslint-disable */
/* prettier-ignore */
// @ts-nocheck
// noinspection JSUnusedGlobalSymbols
// Generated by unplugin-auto-import
${dts}`.trim()}\n`
        },
      },
    ],
  })

  const importsPromise = flattenImports(options.imports)
    .then((imports) => {
      if (!imports.length && !resolvers.length && !dirs?.length)
        console.warn('[auto-import] plugin installed but no imports has defined, see https://github.com/antfu/unplugin-auto-import#configurations for configurations')

      const compare = (left: string | undefined, right: NonNullable<(Options['ignore'] | Options['ignoreDts'])>[number]) => {
        return right instanceof RegExp
          ? right.test(left!)
          : right === left
      }

      options.ignore?.forEach((name) => {
        const i = imports.find(i => compare(i.as, name))
        if (i)
          i.disabled = true
      })

      options.ignoreDts?.forEach((name) => {
        const i = imports.find(i => compare(i.as, name))
        if (i)
          i.dtsDisabled = true
      })

      return unimport.getInternalContext().replaceImports(imports)
    })

  const filter = createFilter(
    options.include || [/\.[jt]sx?$/, /\.astro$/, /\.vue$/, /\.vue\?vue/, /\.svelte$/],
    options.exclude || [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/],
  )
  const dts = preferDTS === false
    ? false
    : preferDTS === true
      ? resolve(root, 'auto-imports.d.ts')
      : resolve(root, preferDTS)

  const multilineCommentsRE = /\/\*.*?\*\//gms
  const singlelineCommentsRE = /\/\/.*$/gm
  const dtsReg = /declare\s+global\s*{(.*?)[\n\r]}/s
  const componentCustomPropertiesReg = /interface\s+ComponentCustomProperties\s*{(.*?)[\n\r]}/gs
  function parseDTS(dts: string) {
    dts = dts
      .replace(multilineCommentsRE, '')
      .replace(singlelineCommentsRE, '')

    const code = dts.match(dtsReg)?.[0]
    if (!code)
      return

    return Object.fromEntries(Array.from(code.matchAll(/['"]?(const\s*[^\s'"]+)['"]?\s*:\s*(.+?)[,;\r\n]/g)).map(i => [i[1], i[2]]))
  }

  async function generateDTS(file: string) {
    await importsPromise
    const dir = dirname(file)
    const originalContent = existsSync(file) ? await fs.readFile(file, 'utf-8') : ''
    const originalDTS = parseDTS(originalContent)
    let currentContent = await unimport.generateTypeDeclarations({
      resolvePath: (i) => {
        if (i.from.startsWith('.') || isAbsolute(i.from)) {
          const related = slash(relative(dir, i.from).replace(/\.ts(x)?$/, ''))
          return !related.startsWith('.')
            ? `./${related}`
            : related
        }
        return i.from
      },
    })
    const currentDTS = parseDTS(currentContent)!
    if (options.vueTemplate) {
      currentContent = currentContent.replace(
        componentCustomPropertiesReg,
        $1 => `interface GlobalComponents {}\n  ${$1}`,
      )
    }
    if (originalDTS) {
      Object.keys(currentDTS).forEach((key) => {
        originalDTS[key] = currentDTS[key]
      })
      const dtsList = Object.keys(originalDTS).sort().map(k => `  ${k}: ${originalDTS[k]}`)
      return currentContent.replace(dtsReg, () => `declare global {\n${dtsList.join('\n')}\n}`)
    }

    return currentContent
  }

  async function parseESLint() {
    const configStr = existsSync(eslintrc.filepath!) ? await fs.readFile(eslintrc.filepath!, 'utf-8') : ''
    const config = JSON.parse(configStr || '{ "globals": {} }')
    return config.globals as Record<string, ESLintGlobalsPropValue>
  }

  async function generateESLint() {
    return generateESLintConfigs(await unimport.getImports(), eslintrc, await parseESLint())
  }

  const writeConfigFilesThrottled = throttle(500, writeConfigFiles, { noLeading: false })

  async function writeFile(filePath: string, content = '') {
    await fs.mkdir(dirname(filePath), { recursive: true })
    return await fs.writeFile(filePath, content, 'utf-8')
  }

  let lastDTS: string | undefined
  let lastESLint: string | undefined
  async function writeConfigFiles() {
    const promises: any[] = []
    if (dts) {
      promises.push(
        generateDTS(dts).then((content) => {
          if (content !== lastDTS) {
            lastDTS = content
            return writeFile(dts, content)
          }
        }),
      )
    }
    if (eslintrc.enabled && eslintrc.filepath) {
      const filepath = eslintrc.filepath
      promises.push(
        generateESLint().then(async (content) => {
          if (filepath.endsWith('.cjs'))
            content = `module.exports = ${content}`
          else if (filepath.endsWith('.mjs') || filepath.endsWith('.js'))
            content = `export default ${content}`

          content = `${content}\n`
          if (content.trim() !== lastESLint?.trim()) {
            lastESLint = content
            return writeFile(eslintrc.filepath!, content)
          }
        }),
      )
    }
    return Promise.all(promises)
  }

  async function scanDirs() {
    if (dirs?.length) {
      await unimport.modifyDynamicImports(async (imports) => {
        const exports_ = await scanDirExports(dirs, root) as ImportExtended[]
        exports_.forEach(i => i.__source = 'dir')
        return modifyDefaultExportsAlias([
          ...imports.filter((i: ImportExtended) => i.__source !== 'dir'),
          ...exports_,
        ], options)
      })
    }
    writeConfigFilesThrottled()
  }

  async function transform(code: string, id: string) {
    await importsPromise

    const s = new MagicString(code)

    await unimport.injectImports(s, id)

    if (!s.hasChanged())
      return

    writeConfigFilesThrottled()

    return {
      code: s.toString(),
      map: s.generateMap({ source: id, includeContent: true, hires: true }),
    }
  }

  return {
    root,
    dirs,
    filter,
    scanDirs,
    writeConfigFiles,
    writeConfigFilesThrottled,
    transform,
    generateDTS,
    generateESLint,
  }
}

export async function flattenImports(map: Options['imports']): Promise<Import[]> {
  const promises = await Promise.all(toArray(map)
    .map(async (definition) => {
      if (typeof definition === 'string') {
        if (!presets[definition])
          throw new Error(`[auto-import] preset ${definition} not found`)
        const preset = presets[definition]
        definition = typeof preset === 'function' ? preset() : preset
      }

      if ('from' in definition && 'imports' in definition) {
        return await resolvePreset(definition as InlinePreset)
      }
      else {
        const resolved: Import[] = []
        for (const mod of Object.keys(definition)) {
          for (const id of definition[mod]) {
            const meta = {
              from: mod,
            } as Import
            if (Array.isArray(id)) {
              meta.name = id[0]
              meta.as = id[1]
            }
            else {
              meta.name = id
              meta.as = id
            }
            resolved.push(meta)
          }
        }
        return resolved
      }
    }))

  return promises.flat()
}

function modifyDefaultExportsAlias(imports: ImportExtended[], options: Options): Import[] {
  if (options.defaultExportByFilename) {
    imports.forEach((i) => {
      if (i.name === 'default')
        i.as = i.from.split('/').pop()?.split('.')?.shift() ?? i.as
    })
  }

  return imports as Import[]
}
