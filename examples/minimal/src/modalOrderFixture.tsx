import { useLayoutEffect, useRef, useState } from "react";
import { Modal, View } from "react-native";

export interface ModalOrderFixtureAPI {
  open(name: "a" | "b"): void;
  snapshot(): { a: boolean; b: boolean; closed: string[] };
}
export function ModalOrderFixture() {
  const [visible, setVisible] = useState({ a: false, b: false }),
    current = useRef(visible),
    closed = useRef<string[]>([]);
  useLayoutEffect(() => {
    current.current = visible;
  });
  useLayoutEffect(() => {
    const api: ModalOrderFixtureAPI = {
      open: (name) => setVisible((previous) => ({ ...previous, [name]: true })),
      snapshot: () => ({ ...current.current, closed: [...closed.current] }),
    };
    const target = globalThis as unknown as { __RNR_MODAL_ORDER__?: ModalOrderFixtureAPI };
    target.__RNR_MODAL_ORDER__ = api;
    return () => {
      if (target.__RNR_MODAL_ORDER__ === api) delete target.__RNR_MODAL_ORDER__;
    };
  }, []);
  return (
    <>
      {(["a", "b"] as const).map((name) => (
        <Modal
          key={name}
          visible={visible[name]}
          transparent
          onRequestClose={() => {
            closed.current.push(name);
            setVisible((previous) => ({ ...previous, [name]: false }));
          }}
        >
          <View
            nativeID={"fixture-modal-order-" + name}
            style={{
              position: "absolute",
              left: 1450,
              top: 620,
              width: 80,
              height: 60,
              backgroundColor: name === "a" ? "#aa3344" : "#3355aa",
            }}
          />
        </Modal>
      ))}
    </>
  );
}
