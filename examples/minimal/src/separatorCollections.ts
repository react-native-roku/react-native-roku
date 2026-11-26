import { createElement, type ComponentProps } from "react";
import { createNativeRoot } from "react-native-roku";
import { FlatList, View } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

type Item = { id: string };
type Controls = Parameters<ComponentProps<typeof FlatList<Item>>["renderItem"]>[0]["separators"];
/** Separator updates through only the installed package's public React API. */
export async function qualifySeparatorCollections() {
  const results = [];
  for (const columns of [1, 2]) {
    const scene = new RecordingSceneGraph(),
      controls = new Map<string, Controls>(),
      observed = new Map<
        string,
        { highlighted: boolean; leadingItem: Item | Item[]; stamp?: string }
      >(),
      root = createNativeRoot(scene, {
        strictMode: true,
        viewport: { width: 400, height: 120 },
        text: {
          prepare() {},
          metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
        },
      });
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed separator: " + message);
    };
    const settle = async () => {
      for (let index = 0; index < 6; index++) {
        await root.whenCommitted();
        root.flush();
      }
    };
    const Separator = (props: {
      highlighted: boolean;
      leadingItem: Item | Item[];
      stamp?: string;
    }) => {
      observed.set(
        Array.isArray(props.leadingItem)
          ? props.leadingItem.map((item) => item.id).join(":")
          : props.leadingItem.id,
        props,
      );
      return createElement(View, { style: { height: 4 } });
    };
    const original = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const render = async (data = original) => {
      observed.clear();
      root.render(
        createElement(FlatList<Item>, {
          data,
          numColumns: columns,
          keyExtractor: (item) => item.id,
          columnWrapperStyle: columns > 1 ? { columnGap: 4 } : undefined,
          initialNumToRender: 5,
          ItemSeparatorComponent: Separator,
          showsVerticalScrollIndicator: false,
          renderItem: ({ item, separators }) => {
            controls.set(item.id, separators);
            return createElement(View, {
              nativeID: "separator-item-" + item.id,
              style: { width: 80, height: 20 },
            });
          },
          style: { width: 400, height: 120 },
        }),
      );
      await settle();
    };
    try {
      await render();
      demand(
        observed.size === Math.ceil(original.length / columns) - 1,
        "separators must address complete rows with no trailing separator",
      );
      const target = controls.get(columns === 1 ? "b" : "c")!,
        retired = target;
      target.highlight();
      target.updateProps("leading", { stamp: "previous" });
      target.updateProps("trailing", { stamp: "current" });
      await settle();
      const leadingKey = columns === 1 ? "a" : "a:b",
        trailingKey = columns === 1 ? "b" : "c:d";
      demand(
        observed.get(leadingKey)?.highlighted && observed.get(trailingKey)?.highlighted,
        "highlight must update both adjacent row separators",
      );
      demand(
        observed.get(leadingKey)?.stamp === "previous" &&
          observed.get(trailingKey)?.stamp === "current",
        "leading/trailing props must merge independently",
      );
      if (columns > 1)
        demand(
          controls.get("c") === controls.get("d"),
          "columns in a row must share the same controller",
        );
      const itemNode = [...scene.nodes.values()].find(
        (node) => node.fields.id === "separator-item-a",
      )!;
      target.unhighlight();
      await settle();
      demand(scene.nodes.get(itemNode.id) === itemNode, "updates must retain native item identity");
      await render(original.filter((item) => item.id !== (columns === 1 ? "b" : "c")));
      await render();
      retired.highlight();
      retired.updateProps("leading", { stamp: "retired" });
      await settle();
      demand(
        !observed.get(trailingKey)?.highlighted &&
          ![...observed.values()].some((props) => props.stamp === "retired"),
        "retired controls must not acquire a returned key",
      );
      const current = controls.get(columns === 1 ? "b" : "c")!;
      demand(current !== retired, "returned cells must have new callback authority");
      current.highlight();
      await settle();
      demand(observed.get(trailingKey)?.highlighted, "current controls must remain usable");
    } finally {
      root.unmount();
    }
    demand(
      scene.nodes.size === 1 && scene.listenerCount === 0,
      "native scene and listeners must retire",
    );
    results.push({
      columns,
      adjacentHighlight: true,
      mergedProps: true,
      rowMetadata: true,
      retiredKeyReuse: true,
      cleanup: true,
    });
  }
  return results;
}
