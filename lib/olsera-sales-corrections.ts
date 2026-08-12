import { collections, type OlseraSalesCorrectionDocument } from "./mongodb.ts";

export const FEBRUARY_2026_CORRECTIONS: Omit<OlseraSalesCorrectionDocument, "createdAt" | "updatedAt">[] = [
  {
    _id: "return:DF0226020500000033:ICED-LEMON-TEA",
    date: "2026-02-05",
    orderNo: "DF0226020500000033",
    itemName: "ICED LEMON TEA",
    qty: -1,
    amount: -21250,
    category: "LABERS",
    correctionType: "return",
    provenance: "official Olsera export / manual-verified",
    note: "Official Olsera export: return -1 / -Rp21.250; historical correction, not a sale or stock movement.",
  },
  {
    _id: "return:DF0226021100000399:RAKET-STANDAR",
    date: "2026-02-11",
    orderNo: "DF0226021100000399",
    itemName: "RAKET STANDAR",
    qty: -2,
    amount: -60000,
    category: "SEWA RAKET",
    correctionType: "return",
    provenance: "official Olsera export / manual-verified",
    note: "Official Olsera export: return -2 / -Rp60.000; historical correction, not a sale or stock movement. RAKET PREMIUM remains unchanged.",
  },
];

export async function loadOlseraSalesCorrections(start: string, end: string) {
  const { olseraSalesCorrections } = await collections();
  return olseraSalesCorrections.find({ date: { $gte: start, $lte: end } }).toArray();
}
