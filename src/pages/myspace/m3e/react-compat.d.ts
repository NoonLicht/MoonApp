/** Код редактора написан под React 19, где `inert` — обычное булево свойство. В React 18 нужна строка. */
import "react";
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    inert?: "" | undefined;
  }
}
