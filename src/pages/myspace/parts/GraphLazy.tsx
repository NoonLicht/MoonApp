import { lazy, Suspense, type ComponentProps } from "react";

/**
 * Граф заметок подгружается отдельным куском только когда его впервые
 * показывают: симуляция и canvas не попадают в стартовый бандл страницы.
 */
const GraphView = lazy(() => import("@/pages/myspace/parts/GraphView"));

export default function GraphLazy(props: ComponentProps<typeof GraphView>) {
  return (
    <Suspense fallback={<div className="graph-container" aria-busy="true" />}>
      <GraphView {...props} />
    </Suspense>
  );
}
