// ESLint の設定。
//
// `npm run lint` は以前 `next lint` を呼んでいたが、設定が無いため実行すると
// 対話プロンプトを出して止まっていた。CIに入れられず、手元でも固まるので、
// package.json に動かないスクリプトが残っている状態だった。
//
// 型チェックで拾えるものは重複させない。ここで見たいのは、型が通っても
// 事故になる書き方のほう。とくに **await し忘れた Promise** は、
// 通知の送信やファイルの書き込みが黙って中断される形で表に出る。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      // 使い捨ての検証スクリプト（.gitignore と同じ規則）
      "_*.ts",
      "_*.mjs",
    ],
  },

  js.configs.recommended,

  // Next の設定はパーサーを差し替えるので、型を見る設定より**先に**置く。
  // 後ろに置くと型情報が消え、await し忘れの検出が動かなくなる
  ...compat.extends("next/core-web-vitals"),

  // 型を見る規則はTypeScriptのファイルだけに当てる
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),

  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 型で拾える・意図的に使っている書き方は落とす
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": "off",

      // 端末とJSXの見出しを揃えるために全角空白を使っている。
      // 文字列の中は既定で見逃されるが、テンプレートリテラルとJSXの
      // 地の文も同じ用途なので同様に許す
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipJSXText: true, skipComments: true },
      ],

      // 使っていない変数は、頭に _ を付けたときだけ許す
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    // スクリプトは console で人に伝えるのが仕事
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
      /*
       * 入口の `main` は `main().catch(...)` の形で呼ぶので、
       * 中で await していなくても Promise を返す必要がある。
       * ここでの async は飾りではなく、失敗を拾うための型。
       */
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    /*
     * テストの構え。
     *
     * `JSON.parse` の戻りや、わざと形を崩した入力を渡す箇所で
     * `any` が出る。ここは**壊れた入力を渡すこと自体が目的**なので、
     * 型の緩さを咎めても直しようがない。本体側は緩めていない。
     */
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },

  // 設定ファイル自身は tsconfig の対象外なので、型を見る規則から外す
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
