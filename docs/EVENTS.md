# 接口与事件约定（拟实现 v1）

下面的接口与事件是本批项目拟采用的应用层约定，均不是 Passport 官方 API。公共约定可独立发布依赖，避免复制十份支付代码；各项目保有自己的业务状态、引擎与验收样本。

## 事件字段

| 字段 | 定义 |
|---|---|
| event_id / schema_version | 事件唯一 ID 与版本，导入去重 |
| operation_id / attempt_id | 一次业务购买与某次执行尝试，不能混为同一层 |
| merchant_request_id | 卖方实际记录的请求，缺失就留空 |
| passport_operation_key | 只在受限记录中关联，归属于 Passport 执行，不自动传给商家 |
| actor_ref / session_ref | 脱敏主体引用与受限 session 引用，不含 token/私钥 |
| request_hash / spec_version | 输入和业务合同版本；摘要不证明资料内容正确 |
| payment_state / fulfillment_state | 两条独立状态，不通过 HTTP 200 自动推导全部交付 |
| network / asset / amount_base_units | 实际网络与资产单位；未验证数据不能填“默认正确值” |
| receipt_ref / transaction_refs | 一笔或多笔实际付款参考，可为空并注明原因 |
| artifact_ref / artifact_hash | 受权产物引用和完整性摘要，不放公开永久下载链接 |
| observed_at / occurred_at | 采集时间与来源事件时间分别记录 |
| evidence_source / evidence_level | mock、captured、live，以及实际来源 |

缺字段不构造假数据；未知状态使用 UNKNOWN。原始证据按用户权限加密保留，普通日志仅含脱敏引用。账务金额按实际结算记录，不以报价、缓存余额或相似时间猜测。

## 幂等边界

Passport 的 --idempotency-key 与卖方业务 operation_id 分别保存。卖方绑定已验证付款主体、请求摘要、规格版本和业务操作；相同 key 但 body 改变返回 conflict。自动重试只限明确可重入且不产生新支出的步骤；付款未决先查询原操作。

## 恢复决策

| 付款 | 交付 | 动作 |
|---|---|---|
| UNKNOWN | 任意 | 核查原尝试与凭证，不新建收费 |
| CONFIRMED | READY/DELIVERED | 鉴权后恢复原产物 |
| CONFIRMED | RUNNING | 恢复原 job 的轮询，不重买 |
| CONFIRMED | FAILED | 按合同进入人工处理，不能改写未付 |
| FAILED且有明确证据 | NOT_STARTED | 向用户说明，后续新尝试按授权边界执行 |
| 无强证据 | 无强证据 | 标证据不足，不因金额接近自动关联 |

自动退款不是本批默认能力；应有实际允许的资金接口、用户批准与付款证据后才设计，未满足只登记人工处理。
