import { SetStateAction, atom, useAtomValue, useSetAtom } from "jotai";
import { ScopeProvider } from "jotai-molecules";
import { atomFamily, selectAtom, useAtomCallback } from "jotai/utils";
import isEqual from "lodash/isEqual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MaterialIcon } from "@axelor/ui/icons/material-icon";

import { useAsyncEffect } from "@/hooks/use-async-effect";
import { useEditor, useSelector } from "@/hooks/use-relation";
import { DataStore } from "@/services/client/data-store";
import { DataRecord } from "@/services/client/data.types";
import { i18n } from "@/services/client/i18n";
import { ViewData } from "@/services/client/meta";
import {
  Editor,
  FormView,
  Panel,
  Property,
  Schema,
} from "@/services/client/meta.types";
import { toKebabCase, toSnakeCase } from "@/utils/names";
import { MetaScope } from "@/view-containers/views/scope";

import { useGetErrors } from "../form";
import { Form, useFormHandlers, usePermission } from "./form";
import { FieldControl } from "./form-field";
import { GridLayout } from "./form-layouts";
import { useAfterActions } from "./scope";
import { FieldProps, FormState, ValueAtom, WidgetAtom } from "./types";
import { nextId, processView } from "./utils";

import styles from "./form-editors.module.scss";

export type FieldEditorProps = FieldProps<any>;
export type FormEditorProps = FieldEditorProps & {
  editor: FormView;
  fields: Record<string, Property>;
};

function processEditor(schema: Schema) {
  const editor: Editor = schema.editor;
  const widgetAttrs = editor.widgetAttrs ?? {};
  const fields = editor.fields ?? schema.fields;
  const flexbox = editor.flexbox ?? false;

  const applyTitle = (item: Schema) => {
    const field = fields?.[item.name!];
    const result = { ...field, ...item };
    result.showTitle = item.showTitle ?? widgetAttrs.showTitles !== "false";
    result.title =
      item.title ?? field?.title ?? (result.showTitle ? field?.autoTitle : "");

    if (!result.showTitle && !result.items) {
      result.placeholder =
        result.placeholder ??
        field?.placeholder ??
        result.title ??
        field?.title;
    }

    return result;
  };

  const applyAttrs = (item: Schema) => {
    const result = applyTitle(item);
    const field = fields?.[item.name!];

    result.colSpan = item.colSpan ?? widgetAttrs.itemSpan;
    result.serverType = item.serverType ?? field?.type;

    if (result.selectionList) {
      result.widget = result.widget ?? "selection";
    }

    if (result.items) {
      result.items = result.items.map((item: Schema) =>
        applyAttrs({ ...item }),
      );
    }

    return result as Schema;
  };

  const items = editor.items?.map((item) =>
    applyAttrs({ ...item }),
  ) as Panel["items"];
  const hasColSpan = flexbox || items?.some((x) => x.colSpan);
  const cols = hasColSpan ? 12 : items?.length;
  const colWidths = hasColSpan
    ? undefined
    : items
        ?.map((x) => {
          const w = x.width ?? x.widgetAttrs?.width;
          return w ?? (x.widget === "toggle" ? "min-content" : "*");
        })
        .join(",");

  const panel: Panel = {
    ...editor,
    type: "panel",
    items: hasColSpan ? items : items?.map((x) => ({ ...x, colSpan: 1 })),
    cols,
    colWidths,
    gap: editor.layout === "table" ? "0.25rem" : undefined,
    showTitle: false,
    showFrame: false,
  };

  const form: FormView = {
    type: "form",
    items: [panel],
    cols: 1,
  };

  return { form, fields };
}

export function FieldEditor(props: FieldEditorProps) {
  const { schema } = props;

  const fieldsAtom = useMemo(
    () =>
      schema.json
        ? atom(schema.jsonFields)
        : selectAtom(props.formAtom, (o) => o.fields),
    [props.formAtom, schema.json, schema.jsonFields],
  );

  const formFields = useAtomValue(fieldsAtom);

  const { form, fields } = useMemo(
    () => processEditor({ ...schema, fields: schema.fields ?? formFields }),
    [formFields, schema],
  );

  // json field?
  if (schema.json) {
    return <JsonEditor {...props} editor={form} fields={fields} />;
  }

  // reference field?
  if (schema.serverType?.endsWith("_TO_ONE")) {
    return <ReferenceEditor {...props} editor={form} fields={fields} />;
  }
  // collection field?
  if (schema.serverType?.endsWith("_TO_MANY")) {
    return <CollectionEditor {...props} editor={form} fields={fields} />;
  }

  return <SimpleEditor {...props} editor={form} fields={fields} />;
}

function SimpleEditor({ editor, fields, ...props }: FormEditorProps) {
  const { formAtom, widgetAtom, readonly } = props;
  const schema = useMemo(() => processView(editor, fields), [editor, fields]);

  return (
    <FieldControl {...props}>
      <GridLayout
        schema={schema}
        formAtom={formAtom}
        parentAtom={widgetAtom}
        readonly={readonly}
      />
    </FieldControl>
  );
}

function ReferenceEditor({ editor, fields, ...props }: FormEditorProps) {
  const { schema, formAtom, widgetAtom, valueAtom, readonly } = props;
  const {
    orderBy,
    searchLimit,
    formView: formViewName,
    gridView: gridViewName,
  } = schema;
  const { attrs } = useAtomValue(widgetAtom);
  const {
    title,
    domain,
    required,
    canEdit,
    canView = true,
    canSelect = true,
  } = attrs;

  const model = schema.target!;

  const showEditor = useEditor();
  const showSelector = useSelector();

  const hasValue = useAtomValue(
    useMemo(() => atom((get) => Boolean(get(valueAtom))), [valueAtom]),
  );

  const icons: boolean | string[] = useMemo(() => {
    const showIcons = String(schema.showIcons || "");
    if (!showIcons || showIcons === "true") return true;
    if (showIcons === "false") return false;
    return showIcons.split(",");
  }, [schema]);

  const canShowIcon = useCallback(
    (icon: string) => {
      if (!icons) return false;
      return icons === true || icons?.includes?.(icon);
    },
    [icons],
  );

  const handleSelect = useAtomCallback(
    useCallback(
      async (get, set) => {
        showSelector({
          model,
          domain,
          orderBy,
          context: get(formAtom).record,
          limit: searchLimit,
          viewName: gridViewName,
          onSelect: (records) => {
            set(valueAtom, records[0], true);
          },
        });
      },
      [
        domain,
        formAtom,
        gridViewName,
        model,
        orderBy,
        searchLimit,
        showSelector,
        valueAtom,
      ],
    ),
  );

  const handleEdit = useAtomCallback(
    useCallback(
      (get, set, readonly: boolean = false) => {
        showEditor({
          model,
          title: title ?? "",
          onSelect: (record) => {
            set(valueAtom, record, true);
          },
          record: get(valueAtom),
          readonly,
          viewName: formViewName,
        });
      },
      [model, formViewName, showEditor, title, valueAtom],
    ),
  );

  const handleDelete = useAtomCallback(
    useCallback(
      (get, set) => {
        set(valueAtom, null, true);
      },
      [valueAtom],
    ),
  );

  const setInvalid = useSetAtom(setInvalidAtom);
  const handleInvalid = useCallback(
    (value: any, invalid: boolean) => {
      if (required || value) {
        setInvalid(widgetAtom, invalid);
      }
    },
    [required, setInvalid, widgetAtom],
  );

  const { itemsFamily, items } = useItemsFamily({
    valueAtom,
    multiple: false,
    canShowNew: !readonly,
  });

  const titleActions = !readonly && (
    <div className={styles.actions}>
      {canEdit && hasValue && canShowIcon("edit") && (
        <MaterialIcon icon="edit" onClick={() => handleEdit(false)} />
      )}
      {canView && !canEdit && hasValue && canShowIcon("view") && (
        <MaterialIcon icon="description" onClick={() => handleEdit(true)} />
      )}
      {canSelect && canShowIcon("select") && (
        <MaterialIcon icon="search" onClick={handleSelect} />
      )}
      {hasValue && canShowIcon("clear") && (
        <MaterialIcon icon="delete" onClick={handleDelete} />
      )}
    </div>
  );

  return (
    <FieldControl {...props} titleActions={titleActions}>
      {items.map((item) => (
        <RecordEditor
          key={item.id}
          schema={schema}
          editor={editor}
          fields={fields}
          formAtom={formAtom}
          widgetAtom={widgetAtom}
          valueAtom={itemsFamily(item)}
          model={model}
          readonly={readonly}
          setInvalid={handleInvalid}
        />
      ))}
    </FieldControl>
  );
}

const IS_NEW = Symbol("isNew");

function useItemsFamily({
  valueAtom,
  exclusive,
  multiple = true,
  canShowNew = true,
}: {
  valueAtom: ValueAtom<DataRecord | DataRecord[]>;
  exclusive?: string;
  multiple?: boolean;
  canShowNew?: boolean;
}) {
  const isNew = useCallback(
    (item: DataRecord) => item && Reflect.get(item, IS_NEW),
    [],
  );

  const isClean = useCallback((item: DataRecord) => {
    return item && Object.keys(item).length === 1;
  }, []);

  const makeArray = useCallback((value: unknown): DataRecord[] => {
    if (Array.isArray(value)) return value;
    if (value) return [value];
    return [];
  }, []);

  const itemsFamily = useMemo(() => {
    return atomFamily(
      (record: DataRecord) =>
        atom(
          (get) => {
            const items = makeArray(get(valueAtom));
            return items.find((x: DataRecord) => x.id === record.id);
          },
          (get, set, value: DataRecord) => {
            if (isNew(value) && isClean(value)) return;
            let items = makeArray(get(valueAtom));
            const found = items.find((x) => x.id === value.id);
            if (found) {
              items = items.map((x) => (x.id === value.id ? value : x));
            }
            if (exclusive && found && value[exclusive]) {
              items = items.map((item) => ({
                ...item,
                [exclusive]: item.id === value.id ? value[exclusive] : false,
              }));
            }
            const next = multiple ? items : items[0] ?? null;
            set(valueAtom, next);
          },
        ),
      (a, b) => a.id === b.id,
    );
  }, [makeArray, valueAtom, isNew, isClean, exclusive, multiple]);

  const itemsAtom = useMemo(() => {
    return atom(
      (get) => {
        const value = get(valueAtom);
        return makeArray(value);
      },
      (get, set, value: DataRecord[]) => {
        const items = makeArray(value);
        const next = multiple ? items : items[0] ?? null;
        set(valueAtom, next);
      },
    );
  }, [makeArray, multiple, valueAtom]);

  const addItem = useAtomCallback(
    useCallback(
      (get, set, record: DataRecord = { id: nextId() }) => {
        const items = get(itemsAtom);
        if (multiple) {
          const last = items[items.length - 1];
          if (last && isClean(last)) return;
          itemsFamily(record);
          set(itemsAtom, [...items, record]);
        } else {
          items.forEach((item) => itemsFamily.remove(item));
          itemsFamily(record);
          set(itemsAtom, makeArray(record));
        }
      },
      [isClean, itemsAtom, itemsFamily, makeArray, multiple],
    ),
  );

  const syncItem = useAtomCallback(
    useCallback(
      (get, set, item: DataRecord) => {
        itemsFamily.remove(item);
        itemsFamily(item);
        const items = get(itemsAtom);
        const next = items.map((x) => (x.id === item.id ? item : x));
        set(itemsAtom, next);
      },
      [itemsAtom, itemsFamily],
    ),
  );

  const removeItem = useAtomCallback(
    useCallback(
      (get, set, record: DataRecord) => {
        itemsFamily.remove(record);
        const items = get(itemsAtom);
        set(
          itemsAtom,
          items.filter((x) => x.id !== record.id),
        );
      },
      [itemsAtom, itemsFamily],
    ),
  );

  const ensureNew = useAtomCallback(
    useCallback(
      (get) => {
        const items = get(itemsAtom);
        if (items.length === 0) {
          const record = {
            id: nextId(),
            [IS_NEW]: true,
          };
          addItem(record);
        }
      },
      [addItem, itemsAtom],
    ),
  );

  const ensureSync = useAtomCallback(
    useCallback(
      (get) => {
        const items = get(itemsAtom);
        const item = items[0];
        if (isNew(item) && !isClean(item)) {
          syncItem({ ...item, [IS_NEW]: undefined });
        }
      },
      [isClean, isNew, itemsAtom, syncItem],
    ),
  );

  const items = useAtomValue(itemsAtom);

  useEffect(() => {
    if (items.length === 0) ensureNew();
    if (items.length === 1) ensureSync();
  }, [ensureNew, ensureSync, items.length]);

  return {
    itemsFamily,
    itemsAtom,
    items,
    addItem,
    syncItem,
    removeItem,
    isClean,
  };
}

function CollectionEditor({ editor, fields, ...props }: FormEditorProps) {
  const { schema, formAtom, widgetAtom, valueAtom, readonly } = props;
  const model = schema.target!;

  const exclusive = useMemo(() => {
    const panel: Schema = editor.items?.[0] ?? {};
    const items = panel.items ?? [];
    return items.find((x) => x.exclusive)?.name;
  }, [editor]);

  const { hasButton } = usePermission(schema, widgetAtom);

  const canNew = !readonly && hasButton("new");
  const canShowNew = canNew && schema.editor.showOnNew !== false;

  const { itemsFamily, items, addItem, removeItem, isClean } = useItemsFamily({
    valueAtom,
    exclusive,
    canShowNew,
  });

  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const setInvalid = useSetAtom(setInvalidAtom);
  const handleInvalid = useCallback(
    (value: DataRecord, invalid: boolean) => {
      if (value && isClean(value)) return;
      if (value) {
        setErrors((errors) => ({ ...errors, [value.id!]: invalid }));
      }
    },
    [isClean],
  );

  const handleAdd = useCallback(() => addItem(), [addItem]);

  useAsyncEffect(async () => {
    const invalid = items.map((x) => errors[x.id!]).some((x) => x);
    setInvalid(widgetAtom, invalid);
  });

  return (
    <FieldControl {...props}>
      <div className={styles.collection}>
        <div className={styles.items}>
          {items.map((item) => (
            <ItemEditor
              key={item.id}
              schema={schema}
              model={model}
              editor={editor}
              fields={fields}
              formAtom={formAtom}
              widgetAtom={widgetAtom}
              valueAtom={itemsFamily(item)}
              remove={removeItem}
              readonly={readonly}
              setInvalid={handleInvalid}
            />
          ))}
        </div>
        {canNew && (
          <div className={styles.actions}>
            <MaterialIcon icon="add" onClick={handleAdd} />
          </div>
        )}
      </div>
    </FieldControl>
  );
}

const ItemEditor = memo(function ItemEditor({
  remove,
  readonly,
  setInvalid,
  ...props
}: FormEditorProps & {
  model: string;
  remove: (record: DataRecord) => void;
  setInvalid: (value: DataRecord, invalid: boolean) => void;
}) {
  const valueAtom = props.valueAtom;
  const handleRemove = useAtomCallback(
    useCallback(
      (get) => {
        remove(get(valueAtom));
      },
      [remove, valueAtom],
    ),
  );
  return (
    <div className={styles.item}>
      <RecordEditor {...props} readonly={readonly} setInvalid={setInvalid} />
      {readonly || (
        <div className={styles.actions}>
          <MaterialIcon icon="close" onClick={handleRemove} />
        </div>
      )}
    </div>
  );
});

const setInvalidAtom = atom(
  null,
  (get, set, widgetAtom: WidgetAtom, invalid: boolean) => {
    const prev = get(widgetAtom);
    const errors = invalid
      ? {
          invalid: i18n.get("{0} is invalid", prev.attrs.title),
        }
      : {};
    if (isEqual(errors, prev.errors ?? {})) return;
    set(widgetAtom, { ...prev, errors });
  },
);

const EMPTY_RECORD = Object.freeze({});

const RecordEditor = memo(function RecordEditor({
  model,
  editor,
  fields,
  formAtom: parent,
  widgetAtom,
  valueAtom,
  readonly,
  setInvalid,
  schema,
}: FormEditorProps & {
  model: string;
  setInvalid: (value: DataRecord, invalid: boolean) => void;
}) {
  const meta: ViewData<FormView> = useMemo(
    () => ({
      model,
      fields,
      view: editor,
    }),
    [editor, fields, model],
  );

  const { formAtom, actionHandler, actionExecutor, recordHandler } =
    useFormHandlers(meta, EMPTY_RECORD, parent);

  const [loaded, setLoaded] = useState<DataRecord>({});

  const editorAtom = useMemo(() => {
    return atom(
      (get) => {
        const value = get(valueAtom) || EMPTY_RECORD;
        const state = get(formAtom);
        const dirty = get(parent).dirty;
        const record = loaded.id && loaded.id === value.id ? loaded : value;
        return {
          ...state,
          dirty,
          record: {
            ...record,
            ...value,
          },
        };
      },
      (get, set, update: SetStateAction<FormState>) => {
        const state =
          typeof update === "function" ? update(get(formAtom)) : update;
        const { record } = state;

        set(formAtom, state);
        if (state.dirty) {
          set(valueAtom, isEqual(record, EMPTY_RECORD) ? null : record);
        }
      },
    );
  }, [formAtom, loaded, parent, valueAtom]);

  const getErrors = useGetErrors();

  const invalidAtom = useMemo(
    () => selectAtom(editorAtom, (state) => getErrors(state) !== null),
    [editorAtom, getErrors],
  );

  const invalid = useAtomValue(invalidAtom);
  const invalidCheck = useAtomCallback(
    useCallback(
      (get, set) => {
        setInvalid(get(valueAtom), invalid);
      },
      [invalid, setInvalid, valueAtom],
    ),
  );

  const ds = useMemo(() => new DataStore(model), [model]);
  const value = useAtomValue(valueAtom);
  const load = useAtomCallback(
    useCallback(
      async (get, set) => {
        const id = value?.id ?? 0;
        if (id <= 0) return;
        const names = Object.keys(fields ?? {});
        const missing = names.some((x) => !Object.hasOwn(value, x));
        if (missing) {
          const rec = await ds.read(id, { fields: names });
          setLoaded(rec);
        }
      },
      [ds, fields, value],
    ),
  );

  useAsyncEffect(async () => invalidCheck(), [invalidCheck]);
  useAsyncEffect(async () => load(), [load]);

  const mountRef = useRef<boolean>();
  const executeAction = useAfterActions(
    useCallback(
      async (action: string) => {
        await actionExecutor.waitFor(100);
        if (mountRef.current) {
          actionExecutor.execute(action);
        }
      },
      [actionExecutor],
    ),
  );

  useEffect(() => {
    mountRef.current = true;
    return () => {
      mountRef.current = false;
    };
  });

  useEffect(() => {
    const id = value?.id ?? 0;
    const { onNew } = schema.editor;
    if (id <= 0 && onNew) executeAction(onNew);
  }, [value?.id, schema.editor, executeAction]);

  return (
    <ScopeProvider scope={MetaScope} value={meta}>
      <Form
        schema={editor}
        recordHandler={recordHandler}
        actionExecutor={actionExecutor}
        actionHandler={actionHandler}
        fields={fields}
        formAtom={editorAtom}
        widgetAtom={widgetAtom}
        readonly={readonly}
      />
    </ScopeProvider>
  );
});

function JsonEditor({
  schema,
  editor,
  fields,
  formAtom,
  widgetAtom,
  valueAtom,
  readonly,
}: FormEditorProps) {
  const modelAtom = useMemo(
    () => selectAtom(formAtom, (x) => x.model),
    [formAtom],
  );
  const model = useAtomValue(modelAtom);
  const jsonModel = schema.jsonModel;

  const jsonAtom = useMemo(() => {
    return atom(
      (get) => {
        const value = get(valueAtom) || "{}";
        const json = JSON.parse(value);
        const $record = get(formAtom).record;
        return { ...json, $record };
      },
      (get, set, update: SetStateAction<any>) => {
        const state =
          typeof update === "function" ? update(get(valueAtom)) : update;
        const record = state ? compactJson(state) : state;
        set(valueAtom, state ? JSON.stringify(record) : null);

        if (jsonModel) {
          const formState = get(formAtom);
          if (formState.record.jsonModel !== jsonModel) {
            set(formAtom, {
              ...formState,
              record: { ...formState.record, jsonModel },
            });
          }
        }
      },
    );
  }, [formAtom, jsonModel, valueAtom]);

  const jsonEditor = useMemo(
    () => ({ ...processJsonView(editor), json: true }) as FormView,
    [editor],
  );

  const setInvalid = useSetAtom(setInvalidAtom);
  const handleInvalid = useCallback(
    (value: any, invalid: boolean) => {
      setInvalid(widgetAtom, invalid);
    },
    [setInvalid, widgetAtom],
  );

  return (
    <RecordEditor
      model={model}
      schema={schema}
      editor={jsonEditor}
      fields={fields}
      formAtom={formAtom}
      widgetAtom={widgetAtom}
      valueAtom={jsonAtom}
      setInvalid={handleInvalid}
      readonly={readonly || schema.readonly}
    />
  );
}

function processJsonView(schema: Schema) {
  const result = { ...schema, $json: true } as Schema;

  if (schema.serverType) {
    result.type = "field";
    result.widget = toKebabCase(schema.widget || schema.serverType);
    result.serverType = toSnakeCase(schema.serverType).toUpperCase();
  }

  if (Array.isArray(result.items)) {
    result.items = result.items.map(processJsonView);
  }

  return result;
}

function compactJson(record: DataRecord) {
  const rec: DataRecord = {};
  Object.entries(record).forEach(([k, v]) => {
    if (k.indexOf("$") === 0 || v === null || v === undefined) return;
    if (typeof v === "string" && v.trim() === "") return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      v = v.map(function (x) {
        return x.id ? { id: x.id } : x;
      });
    }
    rec[k] = v;
  });
  return rec;
}
