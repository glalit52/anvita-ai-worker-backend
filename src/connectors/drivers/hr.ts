import { ConnectorError, type Driver } from "../types.js";

const lc = (v: unknown) => String(v ?? "").toLowerCase();

/** Pick the first present field among Darwinbox's tenant-specific column names. */
const pick = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (row[k] != null && row[k] !== "") return row[k];
  return null;
};

export const hrDrivers: Record<string, Driver> = {
  // ─── Darwinbox ───
  "darwinbox.employees.search": async (i, { call, get }) => {
    const r = await call<{ status?: number | string; message?: string; employee_data?: Record<string, unknown>[] }>("https://{domain}/masterapi/employee", { body: { api_key: get("api_key"), datasetKey: get("dataset_key") } });
    if (!Array.isArray(r.employee_data)) throw new ConnectorError(`Darwinbox: ${r.message ?? "no employee data returned"}`);
    const q = lc(i.query);
    const rows = r.employee_data
      .map((e) => ({
        employee_id: pick(e, "employee_id", "Employee ID", "emp_id"),
        name: pick(e, "full_name", "Full Name", "employee_name", "name") ?? [pick(e, "first_name", "First Name"), pick(e, "last_name", "Last Name")].filter(Boolean).join(" "),
        email: pick(e, "company_email_id", "Company Email ID", "official_email", "email"),
        department: pick(e, "department_name", "Department", "department"),
        designation: pick(e, "designation_name", "Designation", "designation"),
        manager: pick(e, "direct_manager_name", "Reporting Manager", "manager_name"),
        location: pick(e, "office_location", "Location", "location"),
        date_of_joining: pick(e, "date_of_joining", "Date Of Joining", "doj"),
        status: pick(e, "employee_status", "Employee Status", "status"),
      }))
      .filter((e) => !q || [e.employee_id, e.name, e.email, e.department].some((v) => lc(v).includes(q)));
    const joiningAfter = i.joined_after ? Date.parse(String(i.joined_after)) : null;
    const filtered = joiningAfter ? rows.filter((e) => e.date_of_joining && Date.parse(String(e.date_of_joining)) >= joiningAfter) : rows;
    return { total: filtered.length, employees: filtered.slice(0, 200) };
  },
  "darwinbox.leaves.balance": async (i, { call, get }) => {
    const r = await call<{ status?: number | string; message?: string; data?: Record<string, unknown>[] }>("https://{domain}/leavesactionapi/leavebalance", { body: { api_key: get("leave_api_key") ?? get("api_key"), employee_no: [String(i.employee_id)] } });
    if (!Array.isArray(r.data)) throw new ConnectorError(`Darwinbox: ${r.message ?? "no leave data returned"}`);
    return { employee_id: i.employee_id, balances: r.data };
  },

  // ─── Workday (REST v1) ───
  "workday.workers.search": async (i, { call }) => {
    const params = new URLSearchParams({ limit: String(Math.min(Number(i.limit ?? 50), 100)), ...(i.query ? { search: String(i.query) } : {}) });
    const r = await call<{ total: number; data: { id: string; descriptor: string; primaryWorkEmail?: string; businessTitle?: string; primarySupervisoryOrganization?: { descriptor: string }; location?: { descriptor: string } }[] }>(`https://{host}/ccx/api/staffing/v6/{tenant}/workers?${params}`);
    return { total: r.total, workers: r.data.map((w) => ({ id: w.id, name: w.descriptor, email: w.primaryWorkEmail ?? null, title: w.businessTitle ?? null, organization: w.primarySupervisoryOrganization?.descriptor ?? null, location: w.location?.descriptor ?? null })) };
  },
  "workday.worker.time_off": async (i, { call }) => {
    const r = await call<{ total: number; data: { descriptor?: string; quantity?: number; unit?: { descriptor: string }; timeOffPlan?: { descriptor: string } }[] }>(`https://{host}/ccx/api/absenceManagement/v1/{tenant}/balances?worker=${encodeURIComponent(String(i.worker_id))}&limit=50`);
    return { worker_id: i.worker_id, balances: r.data.map((b) => ({ plan: b.timeOffPlan?.descriptor ?? b.descriptor ?? null, balance: b.quantity ?? null, unit: b.unit?.descriptor ?? null })) };
  },
};
