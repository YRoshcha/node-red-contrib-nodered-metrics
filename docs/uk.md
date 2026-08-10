# node-red-contrib-nodered-metrics

Палітра Node-RED для запису й експорту Prometheus-метрик. Вона замінює підхід з Function-нодами та `global.get('metrics')`: config-нода створює метрику **раніше**, ніж ноди, що до неї пишуть. Це прибирає startup race під час рестарту Node-RED.

## Встановлення

Встановіть з локального архіву в каталозі Node-RED:

```bash
npm install @yroshcha/node-red-contrib-nodered-metrics
```

Після інсталяції перезапустіть Node-RED. У палітрі з’явиться категорія **metrics** з нодами **metric** і **metrics exporter**. Config-нода доступна у виборі метрики всередині ноди `metric`.

## Як це працює

```text
[input / business logic] → [metric] → [наступна нода]
                                  │
                                  └── запис у Prometheus registry

[metrics exporter] ── GET /nodeRedMetrics ──> Prometheus
```

`metric` не змінює `msg`: вона лише записує значення метрики та передає те саме повідомлення далі. `metrics exporter` не має входу чи виходу — це самостійний HTTP endpoint.

## Швидкий старт: лічильник подій

1. Додайте на flow ноду **metric** між `inject` і `debug`.
2. У полі **Metric** натисніть кнопку `+` і створіть нову конфігурацію.
3. Оберіть **Counter**.
4. Заповніть:
   - **Prometheus name:** `nodered_events_total`
   - **Description:** `Number of processed events`
   - **Label names:** `step,status,process`
5. У ноді `metric` залиште **Action → Increment counter**, увімкніть **Use node name as step**, задайте зрозумілий **Node name**, наприклад `Kafka consume`.
6. Додайте на будь-яке місце flow ноду **metrics exporter** з шляхом `/nodeRedMetrics`.
7. Натисніть Deploy та відкрийте `http://<node-red-host>:<port>/nodeRedMetrics`.

Після кількох повідомлень ви побачите щось на кшталт:

```prometheus
nodered_events_total{step="Kafka consume",status="success",process="Main flow"} 3
```

## Ноди палітри

### Metric configuration

Це config-нода, яка описує Prometheus-метрику. Вона не розміщується на flow: її вибирають у звичайних нодах `metric`.

| Поле | Опис |
|---|---|
| **Display name** | Назва тільки для редактора Node-RED. |
| **Metric type** | `Counter`, `Histogram`, `Gauge` або `Default metrics`. |
| **Prometheus name** | Реальна назва у Prometheus. Використовуйте префікс `nodered_`. |
| **Description** | Людський опис метрики; якщо порожньо, використовується її назва. |
| **Label names** | Лейбли через кому, наприклад `step,status,process`. |
| **Buckets** | Пороги Histogram у секундах, наприклад `0.1, 0.5, 1, 5`. |

#### Counter

Використовуйте для величин, що лише зростають: кількість повідомлень, успішних запитів, помилок. За конвенцією назва має закінчуватися на `_total`.

Опція **Also track duration** створює companion Histogram. Наприклад, для `nodered_events_total` буде створено `nodered_events_duration_seconds` з такими самими лейблами.

#### Histogram

Використовуйте для тривалостей або розподілів розмірів. Значення передаються методом **Observe duration**. Buckets завжди вказуються у секундах.

#### Gauge

Використовуйте для поточного стану, який може як збільшуватися, так і зменшуватися: довжина черги, кількість активних задач, доступний баланс.

#### Default metrics

Збирає стандартні process-метрики Node.js: пам’ять, CPU, event loop тощо. За замовчуванням вони мають префікс `nodered_` та лейбл `host` зі значенням `HOSTNAME` контейнера/хоста. Додайте таку конфігурацію лише один раз на Node-RED інстанс.

### Metric

Це flow-нода для запису значень. Її підпис на canvas показує назву вибраної метрики, наприклад `metric [events_in_queue]`.

Кнопка копіювання біля поля **Metric** дублює вибрану config-ноду разом із лейблами, buckets та опціями. Копія отримує окрему назву метрики з суфіксом `_copy`; за потреби відредагуйте її перед Deploy.

| Action | Коли застосовувати | Поле значення |
|---|---|---|
| **Increment counter** | Для Counter | **Value**, типово `1` |
| **Observe duration** | Для Histogram або companion duration Histogram Counter | **Duration** у секундах або мілісекундах |
| **Set gauge** | Для Gauge | **Value** |

Значення підтримують стандартний Node-RED typed input: число, `msg`, `flow`, `global` або environment variable. Наприклад, щоб записати `msg.durationMs`, оберіть тип `msg` і введіть `durationMs`; у полі unit оберіть `ms`.

#### Лейбли

Вкажіть лейбл у **Metric configuration** — тільки після цього нода може записувати його значення.

- `step` — якщо його оголошено, за замовчуванням підставляється **Node name**. Можна вимкнути auto та задати typed input вручну.
- `status` — якщо його оголошено, за замовчуванням дорівнює `success`.
- `process` — якщо його оголошено, автоматично дорівнює назві вкладки (flow), де розташована нода.
- **Extra labels** — інші статичні або dynamic labels, наприклад `source = msg.source`.

Якщо передано зайвий лейбл, він буде відкинутий і палітра виведе одне попередження. Якщо не вистачає обов’язкового лейбла, запис безпечно пропускається та також з’являється одне попередження. Однакові попередження дедуплікуються, щоб не засмічувати лог під навантаженням.

### Metrics exporter

Створює HTTP endpoint з поточним вмістом Prometheus registry. Типовий шлях — `/nodeRedMetrics`; він зручний тим, що не конфліктує з іншими палітрами, які використовують `/metrics`.

Налаштування Prometheus:

```yaml
scrape_configs:
  - job_name: node-red
    metrics_path: /nodeRedMetrics
    static_configs:
      - targets: ["node-red:1880"]
```

Не додавайте кілька exporter-нод з одним шляхом на один інстанс. Під час Deploy або видалення ноди її route очищується автоматично.

## Важливі правила

### Ізоляція інстансів

Кожен окремий процес Node-RED має власний Prometheus registry. Метрики з `kafka-worker`, `dashboard` і `gateway` не об’єднуються автоматично: розмістіть config-ноди та exporter на кожному інстансі, який треба скрейпити.

### Не створюйте високу cardinality

Не використовуйте у значеннях лейблів `user_id`, `order_id`, UUID, timestamp, IP адреси або будь-які інші необмежені значення. Це створює величезну кількість time series і може погіршити роботу Prometheus.

Погано:

```text
order_id = msg.order.id
```

Добре: використовуйте обмежені категорії, наприклад `status=success|failed`, `source=kafka|http`, або шаблон на зразок `${order_id}`, якщо потрібна форма без реального id.

### Deploy і зміна лейблів

Звичайний Deploy не скидає Counter, Histogram і Gauge — накопичені дані у registry залишаються. Але змінювати `Label names` існуючої метрики на Deploy не можна: палітра лишить стару схему та попередить у логах. Щоб застосувати новий набір лейблів, виконайте повний рестарт Node-RED.

## Типові сценарії

| Сценарій | Тип | Назва | Action |
|---|---|---|---|
| Оброблено Kafka повідомлень | Counter | `nodered_kafka_messages_total` | Increment counter |
| Час HTTP запиту | Histogram | `nodered_http_request_duration_seconds` | Observe duration |
| Активні jobs | Gauge | `nodered_active_jobs` | Set gauge |
| Час pipeline разом з кількістю запусків | Counter + **Also track duration** | `nodered_pipeline_runs_total` | Increment / Observe duration |

## Діагностика

- **У endpoint немає метрики:** перевірте, що `metric configuration` вибрано, flow задеплоєний, а через `metric` вже пройшло хоча б одне повідомлення.
- **Є warning про labels:** звірте `Label names` у config-ноди зі `step`, `status`, `process` та Extra labels у writer-ноді.
- **Метрика не записується після зміни labels:** це очікувано; повністю перезапустіть Node-RED.
- **Endpoint повертає 404:** перевірте шлях і переконайтесь, що нода exporter додана та задеплоєна саме на цьому Node-RED інстансі.
