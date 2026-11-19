import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default ts.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...ts.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["app/**/*.tsx"],
    plugins: { "react-hooks": hooks },
    rules: { ...hooks.configs.recommended.rules },
  },
);
