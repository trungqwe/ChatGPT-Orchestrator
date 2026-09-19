# Model policy và token budget

Tiers: `worker_economy`, `worker_standard`, `auditor_fast`, `auditor_standard`, `auditor_deep`, `architecture_deep`.

Resolver gọi `model/list`, đọc IDs và supported reasoning efforts rồi áp preference order. Không resolve được thì `MODEL_POLICY_UNAVAILABLE`; không đoán. Luna, Sol, Astra, Gemini chỉ là ví dụ cấu hình.

Routine review dùng standard; architecture/security/concurrency/provenance hoặc hai corrective failures dùng deep. Worker tiêu token edit/test; auditor nhận identity/mục tiêu ngắn và tự đọc local. Ghi usage, giới hạn vòng lặp và budget.
