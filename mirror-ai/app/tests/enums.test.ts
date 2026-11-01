import assert from "node:assert/strict";
import { test } from "node:test";
import { findEnums, moduleDefs, moduleKey, selectModuleEnums } from "../src/enums.ts";

test("reads Kotlin enum constants, their serial names and their lines", () => {
  const source = [
    "package com.core.common",
    "",
    "@Serializable",
    "enum class CTAModuleType {",
    '    // "BILL_PAYMENT" in a comment must not become a constant',
    '    @SerialName("NONE")',
    "    NONE,",
    "",
    '    @SerialName("AUTO_PAY")',
    "    AUTOPAY,",
    "",
    '    @SerialName("BILL_PAYMENT")',
    "    BILL_PAYMENT;",
    "",
    "    companion object {",
    "        fun fromString(value: String) = entries.find { it.name == value }",
    "    }",
    "}",
  ].join("\n");
  const [decl] = findEnums("Config.kt", source);
  assert.equal(decl.enumName, "CTAModuleType");
  assert.equal(decl.language, "kotlin");
  assert.equal(decl.line, 4);
  assert.deepEqual(
    decl.cases.map((item) => [item.name, item.id, item.line]),
    [
      ["NONE", "NONE", 7],
      ["AUTOPAY", "AUTO_PAY", 10],
      ["BILL_PAYMENT", "BILL_PAYMENT", 13],
    ],
  );
});

test("reads Swift cases, raw values and inline lists, and skips switch cases", () => {
  const source = [
    "enum RedirectionTarget: String, Hashable{",
    "    case MY_ACCOUNTS",
    '    case billPayment = "BILL_PAYMENT"',
    "    case GAMES, VOUCHER",
    "",
    "    var isPayment: Bool {",
    "        switch self {",
    "        case .billPayment: return true",
    "        default: return false",
    "        }",
    "    }",
    "}",
  ].join("\n");
  const [decl] = findEnums("RedirectionTarget.swift", source);
  assert.equal(decl.enumName, "RedirectionTarget");
  assert.equal(decl.language, "swift");
  assert.deepEqual(
    decl.cases.map((item) => [item.name, item.id, item.line]),
    [
      ["MY_ACCOUNTS", "MY_ACCOUNTS", 2],
      ["billPayment", "BILL_PAYMENT", 3],
      ["GAMES", "GAMES", 4],
      ["VOUCHER", "VOUCHER", 4],
    ],
  );
});

test("prefers redirection module enums over StringKeys and DynamicLabels", () => {
  const android = [
    ...findEnums(
      "app/src/main/java/com/cwp/app/utils/StringKeys.kt",
      "enum class StringKeys { ONE, TWO, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT, NINE, TEN }",
    ),
    ...findEnums(
      "core/common/src/main/java/com/cwp/core/common/model/configuration/ConfigurationEnums.kt",
      "enum class CTAModuleType { NONE, BILL_PAYMENT, MEDIA_LOUNGE, HELP_N_SUPPORT, HISTORY, TOPUP }",
    ),
  ];
  const ios = [
    ...findEnums(
      "Panama/Constants/Enum.swift",
      "enum DynamicLabels: String { case ONE, TWO, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT, NINE, TEN }",
    ),
    ...findEnums(
      "Panama/CoreClasses/RedirectionTarget.swift",
      "enum RedirectionTarget: String { case BILL_PAYMENT, MEDIA_LOUNGE, HELP_N_SUPPORT, HISTORY, TOPUP, NONE }",
    ),
  ];
  const picked = selectModuleEnums(android, ios);
  assert.equal(picked.android?.enumName, "CTAModuleType");
  assert.equal(picked.ios?.enumName, "RedirectionTarget");
});

test("matches the two module enums by shared constants, not by name", () => {
  const android = findEnums(
    "Config.kt",
    "enum class Weekday { MON, TUE, WED, THU, FRI, SAT }\n" +
      "enum class Catalogue { SHOP, FEED, CATALOG, AISLE, CHECKOUT }\n",
  );
  const ios = findEnums(
    "Router.swift",
    "enum Palette: String { case red, green, blue, teal, pink, grey }\n" +
      "enum Hop: String { case SHOP, FEED, CATALOG, AISLE, SHELF }\n",
  );
  const picked = selectModuleEnums(android, ios);
  assert.equal(picked.android?.enumName, "Catalogue");
  assert.equal(picked.ios?.enumName, "Hop");
});

test("a module's keywords cover both platforms' spellings", () => {
  const [def] = moduleDefs([
    {
      key: "billpayment",
      id: "BILL_PAYMENT",
      label: "Bill payment",
      android: { enumName: "CTAModuleType", caseName: "BILL_PAYMENT", id: "BILL_PAYMENT", file: "a.kt", line: 1 },
      ios: { enumName: "RedirectionTarget", caseName: "billPayment", id: "BILL_PAYMENT", file: "b.swift", line: 1 },
    },
  ]);
  assert.equal(def.id, "billpayment");
  assert.equal(def.label, "Bill payment");
  assert.deepEqual(def.keywords, ["BILL_PAYMENT", "BillPayment", "billPayment"]);
});

test("one key spans the casing each platform uses", () => {
  assert.equal(moduleKey("BILL_PAYMENT"), "billpayment");
  assert.equal(moduleKey("billPayment"), "billpayment");
  assert.equal(moduleKey("Bill Payment"), "billpayment");
});
