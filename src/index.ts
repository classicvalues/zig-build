import * as process from "node:process"

import { fetchDeps } from "./deps"
import { type Logger, makeLogger } from "./log"
import { exec } from "./proc"

type GnuTargetTriple =
  | "x86_64-linux-gnu"
  | "aarch64-linux-gnu"
  | "x86-linux-gnu"
  | "arm-linux-gnueabi"
  | "arm-linux-gnueabihf"
type MacosTargetTriple = "x86_64-macos" | "aarch64-macos"
type NixTargetTriple =
  | GnuTargetTriple
  | MacosTargetTriple
  | "x86_64-linux-musl"
  | "aarch64-linux-musl"
  | "x86-linux-musl"
  | "arm-linux-musleabi"
  | "arm-linux-musleabihf"
export type TargetTriple =
  | NixTargetTriple
  | "x86_64-windows"
  | "aarch64-windows"
  | "x86-windows"

type OutputType = "bin" | "static" | "shared"
type OutputMode = "debug" | "fast" | "small"

type CStd =
  | "c89"
  | "gnu89"
  | "c99"
  | "gnu99"
  | "c11"
  | "gnu11"
  | "c17"
  | "gnu17"
type CppStd =
  | "c++98"
  | "gnu++98"
  | "c++03"
  | "gnu++03"
  | "c++11"
  | "gnu++11"
  | "c++14"
  | "gnu++14"
  | "c++17"
  | "gnu++17"
  | "c++20"
  | "gnu++20"
  | "c++2b"
  | "gnu++2b"
export type Std = CStd | CppStd

type Glibc = `2.${number}`

interface BaseTarget {
  /** Target triple */
  target: TargetTriple
  /** Target CPU */
  cpu?: string
  /** Output file */
  output: string
  /** Output file type (binary executable, dynamic library or static library) */
  type: OutputType
  /** Optimisation mode (debug, fast (default) or small) */
  mode?: OutputMode
  /** Source files to compile into the output */
  sources: string[]
  /**
   * Include paths (-I flag)
   *
   * The Node headers are automatically included.
   * The `node-addon-api` headers are automatically included if the dependency is present.
   **/
  include?: string[]
  /** Linked libraries (-l flag) */
  libraries?: string[]
  /** Library search paths (-L flag) */
  librariesSearch?: string[]
  /** Node-API version */
  napiVersion?: number
  /** Preprocessor defines (-D flag) */
  defines?: Record<string, boolean | string | number>
  /** C/C++ standard */
  std?: Std
  /** Enable or disable C++ exceptions */
  exceptions?: boolean
  /** Compiler flags */
  cflags?: string[]
  /** Print verbose information */
  verbose?: boolean
}
interface NixTarget extends BaseTarget {
  target: NixTargetTriple
  /** Runtime library search paths */
  rpath?: string | string[]
}
interface GnuTarget extends NixTarget {
  target: GnuTargetTriple
  /** Version of glibc to link against */
  glibc?: Glibc
}
interface MacosTarget extends NixTarget {
  target: MacosTargetTriple
  /** Linked frameworks (-f flag) */
  frameworks?: string[]
  /** Frameworks search paths (-F flag) */
  frameworksSearch?: string[]
}
export type Target = BaseTarget | NixTarget | GnuTarget | MacosTarget

// turn an optional array or element into an array
function a<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return []
  else if (Array.isArray(v)) return v
  else return [v]
}

function buildOne(
  target: Target,
  cwd: string,
  node: string,
  zig: string,
  napi: string | null,
  log: Logger,
) {
  let triple = target.target
  if ("glibc" in target && target.glibc) {
    // zig reads the glibc version from the end of gnu triple after a dot
    triple += `.${target.glibc}`
  }

  // base flags for c++ compilation, always the same
  // use baseline instruction set for the target by default
  const flags: string[] = [
    "c++",
    "-target",
    triple,
    `-mcpu=${target.cpu ?? "baseline"}`,
    "-o",
    target.output,
  ]

  switch (target.type) {
    case "bin":
    case "static": {
      flags.push("-static")
      break
    }
    case "shared": {
      // generate position independent code for shared objects
      flags.push("-shared", "-fPIC")
      break
    }
  }

  switch (target.mode ?? "fast") {
    // use -O3 for fast (-Ofast) is not standard compliant
    case "fast": {
      flags.push("-O3")
      break
    }
    // use -Oz for small
    case "small": {
      flags.push("-Oz")
      break
    }
    case "debug":
  }

  if (target.std) {
    flags.push(`-std=${target.std}`)
  }
  if (target.exceptions === false) {
    flags.push("-fno-exceptions")
  }

  flags.push(`-I${node}`)
  if (napi) {
    // add node-addon-api include directory if it's in the dependency tree
    flags.push(`-I${napi}`)
  }
  for (const i of a(target.include)) {
    flags.push(`-I${i}`)
  }

  for (const l of a(target.libraries)) {
    flags.push(`-l${l}`)
  }
  for (const l of a(target.librariesSearch)) {
    flags.push(`-L${l}`)
  }

  target.defines ??= {}
  if (target.napiVersion) {
    // add NAPI_VERSION define but let the user override it
    target.defines = { NAPI_VERSION: target.napiVersion, ...target.defines }
  }
  if (target.exceptions === false) {
    // add node-addon-api defines to disable exceptions and enable safe error handling
    // but let the user override them
    target.defines = {
      NAPI_DISABLE_CPP_EXCEPTIONS: true,
      NODE_ADDON_API_ENABLE_MAYBE: true,
      ...target.defines,
    }
  }
  for (const [n, v] of Object.entries(target.defines)) {
    if (v === true) {
      flags.push(`-D${n}`)
    } else if (typeof v === "string" || typeof v === "number") {
      flags.push(`-D${n}=${v}`)
    }
  }

  if ("frameworks" in target || "frameworksSearch" in target) {
    for (const f of a(target.frameworks)) {
      flags.push(`-${f}`)
    }
    for (const f of a(target.frameworksSearch)) {
      flags.push(`-F${f}`)
    }
  }

  if ("rpath" in target && target.rpath) {
    // specify rpaths as a linker flags
    for (const r of a(target.rpath)) {
      flags.push(`-Wl,-rpath,${r}`)
    }
  }

  if (target.verbose) {
    flags.push("-v")
  }

  flags.push(...a(target.cflags))

  flags.push(...target.sources)

  return exec(zig, flags, { cwd, log })
}

export default async function build(
  targets: Record<string, Target>,
  cwd?: string,
): Promise<void> {
  const [node, zig, napi] = await fetchDeps()
  const tasks = Object.entries(targets).map(([name, target]) =>
    buildOne(target, cwd ?? process.cwd(), node, zig, napi, makeLogger(name)),
  )
  await Promise.all(tasks)
}
