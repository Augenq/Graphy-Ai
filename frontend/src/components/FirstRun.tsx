import { Button, Progress } from "./ui/index";
import { t } from "../lib/i18n";
import { useState } from "react";
import { describe } from "../lib/api";
import { updateAgentSettings, useRemote } from "../lib/remote";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";
import { ProviderSetup } from "./ProviderSetup";

/** Two steps: a provider, a model that can use tools. Nothing is demonstrated: every step is saved. */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const models = useRemote((r) => r.models);
  const settings = useRemote((r) => r.settings);
  const [step, setStep] = useState(0);
  const [model, setModel] = useState(settings?.default_model ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const titles = [t("Подключите провайдера"), t("Выберите модель")];
  const chosen = models.find((m) => m.id === model);
  const canNext = step === 0 ? models.length > 0 : !!chosen?.tools;

  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      if (chosen) await updateAgentSettings({ default_model: chosen.id });
      onDone();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return <Modal label={t("Первый запуск")} onClose={onDone}>
    <div className="p-5">
      <div className="md-typescale-label-large mb-3 text-accent-ui">Graphy · {step + 1} / 2</div>
      <Progress value={(step + 1) / 2} aria-label={t("Шаги")} />
      <h2 className="md-typescale-headline-small m-0 mt-6">{titles[step]}</h2>
      <p className="md-typescale-body-medium mt-3 text-ink-2">
        {step === 0 ? t("Graphy отправляет контекст занятия выбранному провайдеру. История и ответы хранятся только на этом компьютере.") : t("Нужна модель с поддержкой инструментов: без них агент не сможет вести план и проверять ответы.")}
      </p>

      <div className="mt-5 max-h-[46vh] overflow-y-auto">
        {step === 0 && <ProviderSetup />}
        {step === 1 && <ModelPicker value={model} onPick={setModel} name="first-run-model" />}
      </div>

      {error && <p role="alert" className="md-typescale-body-medium m-0 mt-3 text-danger-ui">{error}</p>}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onDone}>{t("Пропустить")}</Button><span className="flex-1" />
        {step > 0 && <Button variant="secondary" onClick={() => setStep(step - 1)}>{t("Назад")}</Button>}
        <Button variant="primary" disabled={!canNext || busy} onClick={() => (step < 1 ? setStep(step + 1) : void finish())}>{step < 1 ? t("Далее") : t("Готово")}</Button>
      </div>
    </div>
  </Modal>;
}
