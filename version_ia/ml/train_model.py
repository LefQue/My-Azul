#!/usr/bin/env python3.12
"""
Entraîne un petit CNN pour classer une case de ligne de motif Azul parmi 6 classes
(les 5 couleurs de tuiles + vide), à partir du dataset produit par prepare_dataset.py,
puis exporte le modèle au format TensorFlow.js pour une inférence 100% dans le navigateur.

Usage:
  source .venv/bin/activate
  python3.12 train_model.py --dataset dataset --out ../tfjs_model
"""
import argparse
import os

# TensorFlow 2.16+ utilise Keras 3 par défaut (config JSON avec `batch_shape`), mais le loader JS de
# TensorFlow.js ne comprend que le schéma Keras 2 legacy (`batch_input_shape`) -- sans ceci, le modèle
# exporté échoue au chargement dans le navigateur avec "An InputLayer should be passed either a
# `batchInputShape` or an `inputShape`". Doit être positionné AVANT tout import de tensorflow/keras.
os.environ["TF_USE_LEGACY_KERAS"] = "1"

import numpy as np
import tensorflow as tf
import tensorflowjs as tfjs

IMG_SIZE = 48  # doit correspondre exactement à PATCH_SIZE côté JS (extractCellPatch)
BATCH = 16


def build_datasets(dataset_dir: str):
    train_ds = tf.keras.utils.image_dataset_from_directory(
        f"{dataset_dir}/train", image_size=(IMG_SIZE, IMG_SIZE), batch_size=BATCH, label_mode="int"
    )
    val_ds = tf.keras.utils.image_dataset_from_directory(
        f"{dataset_dir}/validation", image_size=(IMG_SIZE, IMG_SIZE), batch_size=BATCH, label_mode="int"
    )
    return train_ds, val_ds


def build_model(num_classes: int):
    augment = tf.keras.Sequential([
        tf.keras.layers.RandomFlip("horizontal_and_vertical"),  # une couleur/un motif reste identifiable, orientation non pertinente
        tf.keras.layers.RandomRotation(0.04),   # ~±15° : tolère une calibration des 4 coins imparfaite
        tf.keras.layers.RandomZoom(0.1),        # ±10% : tolère une marge de recadrage imparfaite
        tf.keras.layers.RandomBrightness(0.2),  # ±20% : variations d'éclairage réelles entre les séances de photo
        tf.keras.layers.RandomContrast(0.15),
    ], name="augmentation")

    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(IMG_SIZE, IMG_SIZE, 3)),
        tf.keras.layers.Rescaling(1. / 255),
        tf.keras.layers.Conv2D(16, 3, padding="same", activation="relu"),
        tf.keras.layers.MaxPooling2D(),
        tf.keras.layers.Conv2D(32, 3, padding="same", activation="relu"),
        tf.keras.layers.MaxPooling2D(),
        tf.keras.layers.Conv2D(64, 3, padding="same", activation="relu"),
        tf.keras.layers.MaxPooling2D(),
        tf.keras.layers.Flatten(),
        tf.keras.layers.Dense(64, activation="relu"),
        tf.keras.layers.Dropout(0.3),
        tf.keras.layers.Dense(num_classes, activation="softmax"),
    ])
    return model, augment


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dataset", default="dataset", help="dossier produit par prepare_dataset.py")
    ap.add_argument("--out", default="../tfjs_model", help="dossier de sortie du modèle TensorFlow.js")
    ap.add_argument("--epochs", type=int, default=60)
    args = ap.parse_args()

    train_ds, val_ds = build_datasets(args.dataset)
    class_names = train_ds.class_names
    print("\nOrdre des classes tel que trié par Keras (ALPHABÉTIQUE, pas B,Y,R,K,W,empty) :")
    print(f"  {class_names}")
    print("  -> à recopier EXACTEMENT tel quel côté JS (CNN_LABELS), ne jamais le supposer.\n")

    model, augment = build_model(len(class_names))
    train_ds_aug = train_ds.map(lambda x, y: (augment(x, training=True), y))

    model.compile(
        optimizer=tf.keras.optimizers.Adam(1e-3),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    model.summary()

    early_stop = tf.keras.callbacks.EarlyStopping(
        monitor="val_loss", patience=8, restore_best_weights=True
    )
    model.fit(train_ds_aug, validation_data=val_ds, epochs=args.epochs, callbacks=[early_stop])

    # matrice de confusion, avec un focus explicite sur le cas le plus dur (turquoise/blanc vs vide)
    y_true, y_pred = [], []
    for x, y in val_ds:
        y_true.extend(y.numpy())
        y_pred.extend(np.argmax(model.predict(x, verbose=0), axis=1))

    cm = tf.math.confusion_matrix(y_true, y_pred, num_classes=len(class_names)).numpy()
    print("\nMatrice de confusion (lignes=vrai, colonnes=prédit) :")
    print("classes:", class_names)
    print(cm)

    if "W" in class_names and "empty" in class_names:
        w_idx, empty_idx = class_names.index("W"), class_names.index("empty")
        w_total = cm[w_idx].sum()
        empty_total = cm[empty_idx].sum()
        print(f"\nW confondu avec vide : {cm[w_idx, empty_idx]} / {w_total} exemples vrais W")
        print(f"vide confondu avec W : {cm[empty_idx, w_idx]} / {empty_total} exemples vrais vide")

    tfjs.converters.save_keras_model(model, args.out)
    print(f"\nModèle exporté vers {args.out}/ (model.json + poids). Copie ce dossier à côté de index-scan-cnn.html.")


if __name__ == "__main__":
    main()
