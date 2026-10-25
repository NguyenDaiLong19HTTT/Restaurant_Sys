# Hợp đồng order cho payment — bản tích hợp

Order-service đã tồn tại và là owner order_db. Payment dùng HTTP thật. Hợp đồng đang thực thi, payload, snapshot/hash, payment lock/unlock gắn attempt, mark-paid idempotent và ACK được mô tả đầy đủ tại [CONTRACTS](../integration/CONTRACTS.md). OpenAPI tổng hợp: [integration.openapi.json](../../packages/contracts/integration.openapi.json). Không có settle hoặc receipt tiền mặt trong order-service.
