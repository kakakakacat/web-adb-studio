// Field *names* for protobuf bodies.
//
// The app is built with protobuf-lite, which carries no descriptors at runtime, so
// the device cannot name a single field — it ships raw bytes and the names have to
// come from somewhere else. That somewhere is a FileDescriptorSet produced at build
// time (see `descriptorSetOptions` in Common/build.gradle), packed into the debug
// APK's assets, and pushed down the capture socket once per connection.
//
// Types are resolved from the gRPC method rather than guessed from the payload:
// `dm.…DeviceAccountService/GetWardInfoByDevice` gives the request and response type
// exactly, which beats any heuristic. The wire-format walker in protoscan.ts stays
// as the fallback for bodies whose type we don't know (a plain HTTP protobuf, or an
// app built without the descriptor asset).
//
// This module is imported dynamically, so protobufjs only loads for people who
// actually attach to a collector that offers descriptors.

import protobuf from "protobufjs";
// Side-effect import: this is what adds Root.fromDescriptor.
import "protobufjs/ext/descriptor";

export interface MethodTypes {
  input: string;
  output: string;
}

export class TypeIndex {
  private constructor(
    private readonly root: protobuf.Root,
    /** "pkg.Service/Method" → request/response type names. */
    private readonly methods: Map<string, MethodTypes>
  ) {}

  /** Parse a FileDescriptorSet. Throws if the bytes aren't one. */
  static load(bytes: Uint8Array): TypeIndex {
    // `fromDescriptor` comes from the ext import above; it isn't in the base typings.
    const root = (
      protobuf.Root as unknown as {
        fromDescriptor(buffer: Uint8Array): protobuf.Root;
      }
    ).fromDescriptor(bytes);

    const methods = new Map<string, MethodTypes>();
    walk(root, (obj) => {
      if (!(obj instanceof protobuf.Service)) return;
      for (const method of obj.methodsArray) {
        // gRPC's full method name is "package.Service/Method"; protobufjs stores
        // type names with a leading dot.
        methods.set(`${obj.fullName.replace(/^\./, "")}/${method.name}`, {
          input: method.requestType,
          output: method.responseType,
        });
      }
    });
    return new TypeIndex(root, methods);
  }

  get serviceCount(): number {
    return new Set([...this.methods.keys()].map((k) => k.split("/")[0])).size;
  }

  get methodCount(): number {
    return this.methods.size;
  }

  methodTypes(fullMethod: string): MethodTypes | undefined {
    return this.methods.get(fullMethod.replace(/^\//, ""));
  }

  /**
   * Decode to a plain object, or undefined when the type is unknown or the bytes
   * don't fit it. Returning undefined (rather than throwing) is deliberate: the
   * caller falls back to the field-number view, which is still useful.
   */
  decode(typeName: string | undefined, bytes: Uint8Array): unknown | undefined {
    if (!typeName) return undefined;
    try {
      const type = this.root.lookupType(typeName);
      const message = type.decode(bytes);
      return type.toObject(message, {
        // Names, not numbers, for enums; strings for 64-bit values (a JS number
        // silently loses precision above 2^53, and these carry ids and timestamps);
        // base64 for bytes fields.
        enums: String,
        longs: String,
        bytes: String,
        defaults: false,
        arrays: true,
        objects: true,
      });
    } catch {
      return undefined;
    }
  }

  /** Best-effort type name from the Java class the device reported. */
  fromJavaClass(javaClass: string | undefined): string | undefined {
    if (!javaClass) return undefined;
    // Nested messages come through as Outer$Inner.
    const dotted = javaClass.replace(/\$/g, ".");
    for (const candidate of [dotted, dotted.replace(/^com\./, "")]) {
      try {
        this.root.lookupType(candidate);
        return candidate;
      } catch {
        /* try the next shape */
      }
    }
    return undefined;
  }
}

/** Depth-first walk of a protobufjs namespace tree. */
function walk(obj: protobuf.NamespaceBase, visit: (o: protobuf.ReflectionObject) => void): void {
  visit(obj);
  for (const child of obj.nestedArray) {
    if ("nestedArray" in child) walk(child as protobuf.NamespaceBase, visit);
    else visit(child);
  }
}
