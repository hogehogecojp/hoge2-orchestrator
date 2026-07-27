// 契約テスト本体（tests/contract/tasksWidgetContract.js）を、npm test の
// glob（tests/*.test.js）に載せて実装（buildTasksWidget）で流す薄いラッパ。
import { buildTasksWidget, TASKS_WIDGET_SCHEMA_VERSION } from '../src/engine/tasks-widget.js';
import { runTasksWidgetContract } from './contract/tasksWidgetContract.js';

runTasksWidgetContract({
  buildWidget: buildTasksWidget,
  schemaVersion: TASKS_WIDGET_SCHEMA_VERSION,
});
