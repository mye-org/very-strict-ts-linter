export const isSetterMethodName = (name: string) =>
  name.startsWith("set") && name.length > 3 && name.charAt(3) >= "A" && name.charAt(3) <= "Z";
