import { Switch, Text, View } from "react-native";
import { native } from "../lib/native";

export function SettingSwitch({
  label,
  detail,
  value,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View
      style={{
        minHeight: 54,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: native.label, fontSize: 15 }}>{label}</Text>
        {detail ? (
          <Text style={{ color: native.secondaryLabel, fontSize: 12.5, marginTop: 2 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={detail}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
      />
    </View>
  );
}
