/**
 * Portuguese fiscal obligations calendar. Computes the upcoming deadlines
 * for a company given its VAT regime. Dates follow the general statutory
 * calendar; extraordinary extensions published by the AT are not modelled.
 */

export interface Obligation {
  code: string;
  label: string;
  dueDate: string; // YYYY-MM-DD
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/**
 * Returns obligations due within the next `horizonDays` from `fromDate`.
 */
export function upcomingObligations(
  fromDate: string,
  vatRegime: "mensal" | "trimestral",
  horizonDays = 60
): Obligation[] {
  const from = new Date(fromDate + "T00:00:00Z");
  const limit = new Date(from.getTime() + horizonDays * 86400_000);
  const out: Obligation[] = [];

  const push = (code: string, label: string, dueDate: string) => {
    const d = new Date(dueDate + "T00:00:00Z");
    if (d >= from && d <= limit) out.push({ code, label, dueDate });
  };

  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + 1;

  for (let i = 0; i <= 3; i++) {
    const { year, month } = addMonths(y, m, i);

    // SAF-T mensal: dia 5 do mes seguinte ao periodo.
    const saft = addMonths(year, month, -1);
    push("SAFT", `SAF-T de ${iso(saft.year, saft.month, 1).slice(0, 7)}`, iso(year, month, 5));

    // DMR: dia 10 do mes seguinte.
    const dmr = addMonths(year, month, -1);
    push("DMR", `DMR de ${iso(dmr.year, dmr.month, 1).slice(0, 7)}`, iso(year, month, 10));

    if (vatRegime === "mensal") {
      // Declaracao periodica: dia 20 do 2.o mes seguinte; pagamento dia 25.
      const per = addMonths(year, month, -2);
      push("IVA-DP", `IVA mensal de ${iso(per.year, per.month, 1).slice(0, 7)}`, iso(year, month, 20));
      push("IVA-PAG", `Pagamento IVA de ${iso(per.year, per.month, 1).slice(0, 7)}`, iso(year, month, 25));
    } else if ([2, 5, 8, 11].includes(month)) {
      // Trimestral: dia 20 do 2.o mes seguinte ao fim do trimestre.
      const qEndMonth = month === 2 ? 12 : month - 2;
      const qEndYear = month === 2 ? year - 1 : year;
      const quarter = Math.ceil(qEndMonth / 3);
      push("IVA-DP", `IVA ${quarter}.o trimestre ${qEndYear}`, iso(year, month, 20));
      push("IVA-PAG", `Pagamento IVA ${quarter}.o trimestre ${qEndYear}`, iso(year, month, 25));
    }
  }

  // Anuais.
  for (const yy of [y, y + 1]) {
    push("MOD22", `Modelo 22 (IRC ${yy - 1})`, iso(yy, 5, 31));
    push("IES", `IES (${yy - 1})`, iso(yy, 7, 15));
    push("PEC1", `1.a prestacao pagamento por conta IRC`, iso(yy, 7, 31));
  }

  out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return out;
}
